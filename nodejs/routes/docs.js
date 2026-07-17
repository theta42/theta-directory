'use strict';

const fs = require('fs');
const path = require('path');
const router = require('express').Router();
const {marked} = require('marked');
const conf = require('@simpleworkjs/conf');
const buildInfo = require('../utils/build_info');
const rateLimit = require('../middleware/rate_limit');

const values = {
	title: conf.environment !== 'production' ? `dev` : '',
	titleIcon: conf.environment !== 'production' ? `<i class="fa-brands fa-dev"></i>` : '',
	name: conf.name,
	logo: conf.logo,
	...buildInfo,
};

// Full local copy of the project's documentation, rendered server-side --
// so an operator running air-gapped (no route to GitHub Pages, where this
// content otherwise only lives) can still read it from the running app.
// An explicit slug -> file allowlist, never a user-suppliable path, so
// there's no way to make this read outside the doc set below.
// docs/deployment.md is deliberately excluded -- it's just a stub pointing
// back at the root DEPLOYMENT.md (see docs/deployment.md itself), which is
// already covered by the "deployment" entry.
const DOCS = {
	overview:        {title: 'Overview',        file: path.join(__dirname, '../../README.md')},
	changelog:       {title: 'Changelog',       file: path.join(__dirname, '../../CHANGELOG.md')},
	deployment:      {title: 'Deployment',      file: path.join(__dirname, '../../DEPLOYMENT.md')},
	api:             {title: 'API Reference',   file: path.join(__dirname, '../../API.md')},
	ldap:            {title: 'LDAP',            file: path.join(__dirname, '../../docs/ldap.md')},
	oauth:           {title: 'OAuth',           file: path.join(__dirname, '../../docs/oauth.md')},
	configuration:   {title: 'Configuration',   file: path.join(__dirname, '../../docs/configuration.md')},
	'directory-spec': {title: 'Directory Spec (draft)', file: path.join(__dirname, '../../directory_spec.md')},
};

const docList = Object.entries(DOCS).map(([slug, d]) => ({slug, title: d.title}));

// README.md links its screenshots as repo-relative "docs/images/...", which
// only resolves correctly on GitHub. Serve that same folder here and rewrite
// the rendered markup to point at it absolutely, so the images work when
// read from /docs/overview too.
router.use('/images', require('express').static(path.join(__dirname, '../../docs/images')));
function fixImagePaths(html) {
	return html.replace(/(["(])docs\/images\//g, '$1/docs/images/');
}

router.use(rateLimit.docs);

router.get('/', function(req, res) {
	res.render('docs_index', {...values, docs: docList});
});

// Plain, dependency-free line-substring search over the same allowlisted
// doc set -- no separate index to build/maintain, no new dependency, and it
// keeps working with no internet access (same reasoning as the rest of this
// route). Must be registered before the /:slug catch-all below, or "search"
// would be treated as a (nonexistent) doc slug and 404.
router.get('/search', function(req, res) {
	const q = (req.query.q || '').trim();
	if (!q) return res.json({results: []});
	const qLower = q.toLowerCase();

	const results = [];
	for (const [slug, doc] of Object.entries(DOCS)) {
		try {
			const content = fs.readFileSync(doc.file, 'utf8');
			const matchLine = content.split('\n').find(line => line.toLowerCase().includes(qLower));
			if (matchLine) {
				results.push({slug, title: doc.title, snippet: matchLine.trim().slice(0, 200)});
			}
		} catch (error) { /* unreadable doc file -- skip it */ }
	}

	res.json({results});
});

router.get('/:slug', function(req, res, next) {
	const doc = DOCS[req.params.slug];
	if (!doc) return next({status: 404, message: 'Doc not found'});

	try {
		const content = fs.readFileSync(doc.file, 'utf8');
		res.render('docs_page', {
			...values,
			docs: docList,
			currentSlug: req.params.slug,
			docTitle: doc.title,
			docHtml: fixImagePaths(marked(content)),
		});
	} catch (error) {
		next(error);
	}
});

module.exports = router;
