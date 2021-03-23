module.exports = {
	subject: 'Password reset for {{ name }} account',
	message: `
<h2> {{ name }} account</h2>

<p>
	Hello {{ user.givenName }},
</p>

<p>
	You have asked to reset the password for user name <b>{{ user.uid }}</b> . Please
	click the link below to complete this request. If this was done in errror,
	please ignore this email.
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
