'use strict';

// The notification email body is rendered with a TRIPLE mustache
// (`{{{message}}}`), so nothing in it is escaped by the template. That is
// deliberate -- callers compose markup -- and it means every caller owns its
// own escaping.
//
// `routes/access_request.js` did not, and the string it forgot is the one an
// attacker controls: `req.body.note`, written by whoever is asking for access,
// interpolated into an email sent to the resource OWNER. A privileged
// recipient, a trusted-looking mail, and live HTML from an unprivileged
// stranger.
//
// Pure unit tests: no server, no LDAP, no SMTP. The point is the contract
// between the template and the strings put through it.

const mustache = require('mustache');
const { escapeHtml } = require('../utils/html_escape');
const template = require('../views/email_templates/notification');

// The exact body routes/access_request.js builds when a request is created.
function requestCreatedBody({ uid, resourceName, groupCn, note }) {
  return `<p><strong>${escapeHtml(uid)}</strong> has requested access to <strong>${escapeHtml(resourceName)}</strong> (group <code>${escapeHtml(groupCn)}</code>).</p>`
    + (note ? `<p>Their note: ${escapeHtml(note)}</p>` : '')
    + `<p>Review it on the Directory page.</p>`;
}

const render = (message) => mustache.render(template.message, {
  givenName: 'William', message, name: 'Theta',
});

describe('escapeHtml', () => {
  test('neutralises every character that can change markup', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  test('escapes the ampersand first, so nothing is double-encoded', () => {
    // A naive ordering turns `<` into `&lt;` and then the `&` of `&lt;` into
    // `&amp;lt;`. The reader sees the raw entity instead of the character.
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  test('null and undefined render as nothing, not "null"', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  test('leaves ordinary prose untouched', () => {
    const note = 'I need this for the Tuesday deploy, thanks!';
    expect(escapeHtml(note)).toBe(note);
  });
});

describe('an access-request note cannot inject markup into the owner email', () => {
  test('a link in the note is delivered as text, not as a link', () => {
    const note = '<a href="https://evil.example/approve">Click here to approve this request</a>';
    const out = render(requestCreatedBody({
      uid: 'mallory', resourceName: 'Emby', groupCn: 'site_x_app_emby_access', note,
    }));

    expect(out).not.toContain('<a href="https://evil.example/approve">');
    expect(out).toContain('&lt;a href=&quot;https://evil.example/approve&quot;&gt;');
  });

  test('an unclosed tag cannot hide the instruction that follows it', () => {
    // The second half of the original attack: `<p style="color:#fff">` swallowed
    // "Review it on the Directory page." so the owner never saw the real route.
    const out = render(requestCreatedBody({
      uid: 'mallory', resourceName: 'Emby', groupCn: 'g', note: '<p style="color:#fff">',
    }));
    expect(out).toContain('Review it on the Directory page.');
    expect(out).not.toContain('<p style="color:#fff">');
  });

  test('a resource name and a uid are escaped too', () => {
    // Lower risk -- both are set by privileged paths -- but "everything that
    // goes through the triple mustache is escaped" is the only rule that stays
    // true as this code changes.
    const out = render(requestCreatedBody({
      uid: '<b>root</b>', resourceName: 'R&D <script>', groupCn: 'g', note: '',
    }));
    expect(out).not.toContain('<b>root</b>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('R&amp;D');
  });

  test('the markup the template itself emits still renders', () => {
    // The escaping must not have turned the whole body into plain text -- the
    // template is HTML mail and the <strong>/<code> wrappers are ours.
    const out = render(requestCreatedBody({
      uid: 'alice', resourceName: 'Emby', groupCn: 'g', note: 'please',
    }));
    expect(out).toContain('<strong>alice</strong>');
    expect(out).toContain('<code>g</code>');
  });
});

describe('the subject line', () => {
  // A subject is plain text. `{{subject}}` HTML-escaped it, so a resource named
  // "R&D Wiki" arrived in the inbox as "Access request: R&amp;D Wiki".
  test('is passed through verbatim', () => {
    const subject = "Access request: R&D Wiki (Bill's)";
    expect(mustache.render(template.subject, { subject })).toBe(subject);
  });
});
