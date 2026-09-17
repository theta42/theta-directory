module.exports = {
	// A subject line is plain text, not HTML, so it must NOT be escaped.
	// `{{subject}}` (double mustache) HTML-escapes, which delivered a resource
	// named "R&D Wiki" to the inbox as "Access request: R&amp;D Wiki".
	// Triple mustache passes it through verbatim -- callers are responsible for
	// not putting markup in a subject, which none do.
	subject: '{{{subject}}}',
	message: `
<p>Hi {{givenName}},</p>

{{{message}}}

<p>—<br>{{ name }}</p>
`,
};
