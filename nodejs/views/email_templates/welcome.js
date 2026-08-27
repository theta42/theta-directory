module.exports = {
	subject: 'Welcome to {{ name }}!',
	message: `
<p>
	Welcome {{user.givenName}},
</p>

<p>
	Your new {{ name }} Single sign-on account is ready to use. Here is some
	information to get you started.
</p>

<p>
	Your username is <b>{{user.uid}}</b>
</p>

<p>
	You can manage your account at <a href="{{ ssoUrl }}">{{ ssoUrl }}</a>
</p>

<p>
	The SSO service is still in beta, so please report any bugs you may find!
	You will be notified of new features and services as they become available.
</p>
	Thank you,<br />
	{{ name }}
</p>
`
};
