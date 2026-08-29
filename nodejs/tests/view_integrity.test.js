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
const views = fs.readdirSync(viewsDir).filter(f => f.endsWith('.ejs'));

// Strip EJS tags so what is left is what a browser would receive.
const stripEjs = (src) => src.replace(/<%[\s\S]*?%>/g, '');

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
  for (const file of views) {
    const html = stripEjs(fs.readFileSync(path.join(viewsDir, file), 'utf8'));
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let m, i = 0;
    while ((m = re.exec(html)) !== null) {
      const attrs = m[1] || '';
      if (/\bsrc=/i.test(attrs)) continue;                 // external
      if (/type=["']?(?!text\/javascript|module)/i.test(attrs)) continue; // templates
      blocks.push({ file, index: i++, code: m[2] });
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
    // Inline handlers may also be plain statements (`onkeydown="if(...){...}"`),
    // so keywords are not function names.
    const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'new', 'do', 'catch']);
    const called = new Set();
    for (const m of src.matchAll(/on(?:click|change|keyup|keydown)="([a-zA-Z_$][\w$]*)\s*\(/g)) {
      if (!KEYWORDS.has(m[1])) called.add(m[1]);
    }
    expect(called.size).toBeGreaterThan(10);

    const missing = [...called].filter(fn =>
      !new RegExp(`function\\s+${fn}\\b`).test(src) &&
      !new RegExp(`\\b(?:const|let|var)\\s+${fn}\\s*=`).test(src));
    expect(missing).toEqual([]);
  });
});
