'use strict';

// The views actually parse and run.
//
// This exists because 664 passing tests did not notice that the entire
// directory page was dead. A nested script tag inside a JS template literal
// truncated the page's script element at the HTML level, left the literal
// unterminated, and made the whole block a syntax error -- so every function on
// the page, the tree renderer included, was never defined. The page rendered an
// empty table with its own source printed underneath.
//
// Nothing server-side can catch that: the template compiled, every route
// returned 200, and every API test passed. The bug lived entirely in how a
// browser parses the response.

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const viewsDir = path.join(__dirname, '..', 'views');
const publicDir = path.join(__dirname, '..', 'public');
const views = fs.readdirSync(viewsDir).filter(f => f.endsWith('.ejs'));

// Strip EJS tags so what is left is what a browser would receive.
const stripEjs = (src) => src.replace(/<%[\s\S]*?%>/g, '');

// A view can now load part of its own logic via <script src="/static/js/...">
// (see resource_status.js/resource_facts.js, and the directory.ejs
// decomposition this enables) instead of everything living in one inline
// block. Those files are just as capable of silently killing the page as a
// broken inline block -- a syntax error in one fails to load at all, and any
// onclick handler that only exists there is invisible to a check that reads
// only directory.ejs's own source. Resolve each local <script src> the same
// way express.static actually serves it (app.js's `/static` mount ->
// nodejs/public) so both checks below hold external files to the same bar as
// inline ones. A src that isn't under /static (a CDN, `/static-modules/...`
// third-party bundle) is out of this repo's control and not this test's
// concern.
function externalScriptSources(html) {
  const out = [];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
    if (!srcMatch || !srcMatch[1].startsWith('/static/')) continue;
    const filePath = path.join(publicDir, srcMatch[1].slice('/static/'.length));
    if (!fs.existsSync(filePath)) continue;
    out.push({ src: srcMatch[1], filePath, code: fs.readFileSync(filePath, 'utf8') });
  }
  return out;
}

describe('every view compiles', () => {
  for (const file of views) {
    test(file, () => {
      expect(() => ejs.compile(fs.readFileSync(path.join(viewsDir, file), 'utf8'),
        { filename: path.join(viewsDir, file) })).not.toThrow();
    });
  }
});

describe('script elements are not closed from inside a string', () => {
  // An HTML parser ends a script element at the first `</script` in the source,
  // whatever JavaScript context it appears to be in. A template literal that
  // contains one therefore cuts the page's own script in half.
  for (const file of views) {
    test(file, () => {
      const html = stripEjs(fs.readFileSync(path.join(viewsDir, file), 'utf8'));
      const opens = (html.match(/<script\b/gi) || []).length;
      const closes = (html.match(/<\/script\s*>/gi) || []).length;
      expect(`${file}: ${opens} open, ${closes} close`).toBe(`${file}: ${opens} open, ${opens} close`);
    });
  }
});

describe('inline scripts are syntactically valid JavaScript', () => {
  // Extract each script block the way a browser delimits them, and parse it.
  // A block that does not parse is a page whose behaviour silently does not
  // exist.
  const blocks = [];
  const seenExternal = new Set();
  for (const file of views) {
    const html = stripEjs(fs.readFileSync(path.join(viewsDir, file), 'utf8'));
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let m, i = 0;
    while ((m = re.exec(html)) !== null) {
      const attrs = m[1] || '';
      if (/\bsrc=/i.test(attrs)) continue;                 // external -- checked separately below
      if (/type=["']?(?!text\/javascript|module)/i.test(attrs)) continue; // templates
      blocks.push({ file, index: i++, code: m[2] });
    }
    for (const ext of externalScriptSources(html)) {
      if (seenExternal.has(ext.filePath)) continue; // more than one view may load the same file
      seenExternal.add(ext.filePath);
      blocks.push({ file: ext.src, index: 0, code: ext.code });
    }
  }

  test('there are inline scripts to check', () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  for (const b of blocks) {
    test(`${b.file} block ${b.index}`, () => {
      // `new Function` compiles without executing: a SyntaxError here is a
      // page that a browser would also refuse to run.
      expect(() => new Function(b.code)).not.toThrow();
    });
  }
});

describe('the directory page defines what its own markup calls', () => {
  // Inline onclick="..." handlers name functions the page must define. When the
  // script block died, every one of these was a ReferenceError on click.
  test('every onclick target exists in the page source', () => {
    const src = fs.readFileSync(path.join(viewsDir, 'directory.ejs'), 'utf8');
    // A handler may now be defined in an external file directory.ejs loads
    // via <script src="/static/js/...">, not only inline -- search both, the
    // same union a browser actually resolves the name against.
    const externalSrc = externalScriptSources(src).map(e => e.code).join('\n');
    const searchable = src + '\n' + externalSrc;
    // Inline handlers may also be plain statements (`onkeydown="if(...){...}"`),
    // so keywords are not function names.
    const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'new', 'do', 'catch']);
    const called = new Set();
    for (const m of src.matchAll(/on(?:click|change|keyup|keydown)="([a-zA-Z_$][\w$]*)\s*\(/g)) {
      if (!KEYWORDS.has(m[1])) called.add(m[1]);
    }
    expect(called.size).toBeGreaterThan(10);

    const missing = [...called].filter(fn =>
      !new RegExp(`function\\s+${fn}\\b`).test(searchable) &&
      !new RegExp(`\\b(?:const|let|var)\\s+${fn}\\s*=`).test(searchable));
    expect(missing).toEqual([]);
  });
});
