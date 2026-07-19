'use strict';

const nodemailer = require('nodemailer');
const mustache = require('mustache');
const conf = require('@simpleworkjs/conf');

var Mail = {};

Mail.send = function(to, subject, message, from){
	// Never let the automated test suite deliver real mail — tests run against
	// this app's real routes (notification broadcast, password reset, invite,
	// OTP-by-email, …) with NODE_ENV=test, and any of them resolving a real
	// recipient list must not actually hit SMTP. Tests already tolerate this
	// (see e.g. tests/misc.test.js: "SMTP failure is non-fatal") since none
	// assert on real delivery.
	if(conf.environment === 'test'){
		return Promise.resolve({accepted: [], rejected: [], response: 'skipped: NODE_ENV=test'});
	}

	return new Promise(function(resolve, reject){
		var transportOpts = {
			host: conf.smtp.host || 'localhost',
			port: conf.smtp.port || 25,
			secure: conf.smtp.secure !== undefined ? conf.smtp.secure : false
		};

		if (conf.smtp.user && conf.smtp.pass) {
			transportOpts.auth = {
				user: conf.smtp.user,
				pass: conf.smtp.pass
			};
		}

		var transporter = nodemailer.createTransport(transportOpts);

		var mailOpts = {
			from: from || conf.smtp.from || `${conf.name} Accounts <noreply@theta42.com>`,
			to: to,
			subject: subject,
			html: message
		};

		transporter.sendMail(mailOpts, function(err, info){
			if (err) {
				reject(err);
			} else {
				resolve(info);
			}
		});
	});
};


Mail.sendTemplate = async function(to, template, context, from){
	context.name = conf.name;
	template = require(`../views/email_templates/${template}`);
	await Mail.send(
		to,
		mustache.render(template.subject, context),
		mustache.render(template.message, context),
		from || (template.from && mustache.render(template.from, context))
	)
};

module.exports = {Mail};
