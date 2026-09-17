'use strict';

/**
 * Escape a value for interpolation into HTML.
 *
 * This exists because `views/email_templates/notification.js` renders its body
 * with a TRIPLE mustache (`{{{message}}}`). That is deliberate -- the callers
 * legitimately compose markup -- but it moves the escaping obligation onto
 * every caller, and a caller that forgets has no visible symptom until someone
 * sends a hostile string.
 *
 * `routes/access_request.js` forgot. `req.body.note` is written by whoever is
 * asking for access, and it was interpolated into an email sent to the resource
 * OWNER as live HTML:
 *
 *     <p>Their note: <a href="https://evil.example/approve">Click here to
 *     approve this request</a><p style="color:#fff"></p>
 *
 * — a working link to someone else's domain inside a mail the owner trusts,
 * with the real "Review it on the Directory page" line hidden after it by the
 * unclosed tag. `decisionNote` did the same in the other direction.
 *
 * `>` is escaped as well. It is not strictly required inside element content,
 * but half-escaping is what stops being safe the moment a string is moved into
 * an attribute, and the cost of being complete is nil.
 */
function escapeHtml(value) {
	return String(value == null ? '' : value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

module.exports = { escapeHtml };
