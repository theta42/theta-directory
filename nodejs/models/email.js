'use strict';

const nodemailer = require('nodemailer');
const mustache = require('mustache');
const conf = require('@simpleworkjs/conf');

var Mail = {};

Mail.send = function(to, subject, message, from){
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
		from || (template.from && mustache.render(template.message, context))
	)
};

module.exports = {Mail};
