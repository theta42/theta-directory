module.exports = {
	subject: 'Your {{ name }} login code',
	message: `
<p>Hi {{ givenName }},</p>
<p>Your one-time login code is:</p>
<h2 style="letter-spacing:0.3em;font-family:monospace;font-size:2.5em">{{ code }}</h2>
<p>This code expires in <strong>10 minutes</strong> and can only be used once.</p>
<p>If you did not request this code, you can safely ignore this email.</p>
<p>Thank you,<br/>{{ name }}</p>
`
};
