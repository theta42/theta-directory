module.exports = {
	subject: 'Validate email for {{ name }} account',
	message: `
<h2> {{ name }} account</h2>

<p>
	Welcome,
</p>

<p>
	We need to verify the provided email address in order to continue. Please
	follow the link below to verify this email address:
</p>

<p>
	{{ link }}
</p>

</p>
	Thank you,<br />
	{{ name }}
</p>
`
};
