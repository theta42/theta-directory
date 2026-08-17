'use strict';

/**
 * Spoke Write Proxy Middleware
 *
 * Implements the Pragmatic Hub & Spoke pattern:
 * - Read requests (GET, HEAD, OPTIONS) execute locally against the Spoke's local cache.
 * - Mutating requests (POST, PUT, PATCH, DELETE) to API routes are transparently forwarded
 *   to the Master directory over HTTPS, authenticated with the cluster Site Join Key and
 *   forwarding the user context.
 * - If the Master is unreachable during a mutating request, returns HTTP 503 indicating
 *   the directory is currently in read-only offline mode.
 */

const siteConfig = require('../utils/site_config');

const EXEMPT_PATHS = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/site(\/|$)/,
  /^\/api\/mesh\/self(\/|$)/,
  /^\/api\/directory-admin\/site-promote(\/|$)/
];

function isExempt(path) {
  return EXEMPT_PATHS.some((regex) => regex.test(path));
}

async function spokeWriteProxy(req, res, next) {
  const cfg = siteConfig.get();

  // If this node is the master, it is the canonical write authority -- no proxying needed.
  if (cfg.isMaster) {
    return next();
  }

  // Safe/read-only HTTP methods always serve locally from the spoke's local cache.
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Exempt local lifecycle / auth endpoints from forwarding.
  if (isExempt(req.path)) {
    return next();
  }

  const masterUrl = String(cfg.masterUrl || '').replace(/\/+$/, '');
  if (!masterUrl) {
    return res.status(503).json({
      status: 'error',
      message: 'This node is a spoke with no master URL configured. Operating in read-only offline mode.'
    });
  }

  const targetUrl = `${masterUrl}${req.originalUrl}`;

  const forwardHeaders = { ...req.headers };
  delete forwardHeaders.host;
  delete forwardHeaders['content-length'];
  delete forwardHeaders['transfer-encoding'];
  delete forwardHeaders['connection'];

  // Ensure authorization header is set with master join key if not already provided
  if (!forwardHeaders['authorization'] && cfg.masterJoinKey) {
    forwardHeaders['authorization'] = `Bearer ${cfg.masterJoinKey}`;
  }

  // Forward user context
  if (req.user && req.user.uid) {
    forwardHeaders['x-forwarded-user'] = req.user.uid;
  }
  forwardHeaders['x-forwarded-for'] = req.ip || req.headers['x-forwarded-for'] || '';
  forwardHeaders['x-forwarded-proto'] = req.protocol || 'http';
  forwardHeaders['x-forwarded-spoke'] = cfg.siteSlug || 'spoke';

  let body = undefined;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      body = JSON.stringify(req.body);
      forwardHeaders['content-type'] = forwardHeaders['content-type'] || 'application/json';
    } else if (typeof req.body === 'string' && req.body.length > 0) {
      body = req.body;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const resp = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
      signal: controller.signal
    });
    clearTimeout(timer);

    res.status(resp.status);

    for (const [k, v] of resp.headers.entries()) {
      if (!['content-encoding', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    }

    const data = await resp.arrayBuffer();
    res.send(Buffer.from(data));
  } catch (err) {
    clearTimeout(timer);
    return res.status(503).json({
      status: 'error',
      message: `Master directory at ${masterUrl} unreachable for write operations (${err.message}). Local directory is currently in read-only offline mode.`
    });
  }
}

module.exports = spokeWriteProxy;
