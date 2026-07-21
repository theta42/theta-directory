---
layout: default
title: OAuth / OIDC
description: SSO Manager's OpenID Connect / OAuth 2.0 provider — discovery document, client registration, and token endpoints.
---

# OAuth 2.0 / OpenID Connect

[← Back to Home](index.html)

> Looking for a plainer explanation of clients/scopes/redirect URIs instead
> of endpoint-level detail? See
> [Connecting Apps (Single Sign-On)](concepts-oauth-apps.html).

SSO Manager is an **OpenID Connect / OAuth 2.0 provider**: it issues its own
access, refresh, and ID tokens that your apps can consume to authenticate
users and authorize API calls. It also runs a full OpenLDAP directory, so it
can be both your SSO and your user directory at once.

## Discovery

The provider publishes a standards-compliant discovery document:

```
GET https://<sso-host>/.well-known/openid-configuration
```

It advertises the `issuer`, `authorization_endpoint`, `token_endpoint`,
`userinfo_endpoint`, `end_session_endpoint`, supported scopes, and token
lifetimes. OIDC clients (e.g. the theta42/proxy) can read their endpoint URLs
from here rather than configuring each one.

The `issuer` advertised is `conf.oauth.issuer` — set it to the **browser-facing**
HTTPS URL the SSO is served at (e.g. `https://sso.example.com`), either in
`conf/secrets.js` or via `app_oauth__issuer` / `OAUTH_ISSUER`.

## OAuth clients

An OAuth client represents an app that authenticates against the SSO. Each has:

- `client_id` (UUID) + `client_secret` (bcrypt-hashed; the **raw secret is
  shown once** when the client is created or rotated — save it immediately).
- `name`, `description`, `created_by` (the admin uid that created it).
- `redirect_uris` — allowed callback URLs. Each entry matches exactly, or may
  use `*` (one hostname label) / `**` (any number of labels) as a wildcard —
  e.g. `https://*.example.com/__proxy_auth/callback` covers every host
  theta42/proxy fronts under `example.com`, so you don't have to register
  each proxied host's callback individually.
- `scopes` — requested scopes (default `openid profile email groups`).
- `allowed_groups` — restrict the client to members of specific SSO groups
  (empty = any valid user).
- `token_lifetime` — `access_token` / `refresh_token` lifetimes (seconds).

### Managing clients

Clients are managed from the web UI (as a member of the `app_sso_oauth_admin`
group) or the HTTP API at `/api/oauth/client` (auth via the `auth-token` header
from a login):

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/api/oauth/client` | list clients |
| `POST` | `/api/oauth/client` | create a client (returns the raw `client_secret` once) |
| `GET` | `/api/oauth/client/:id` | get one |
| `PUT` | `/api/oauth/client/:id` | update redirect URIs / scopes / groups |
| `DELETE` | `/api/oauth/client/:id` | delete |
| `POST` | `/api/oauth/client/:id/rotate` | rotate the secret (returns the new raw secret once) |

> All client-management endpoints are gated by the `app_sso_oauth_admin` group.

## Scopes

| Scope | Claims / access |
|-------|-----------------|
| `openid` | OIDC ID token + discovery |
| `profile` | `preferred_username`, display name, etc. |
| `email` | the user's `mail` |
| `groups` | the user's group memberships (the `groups` claim) |

The `groups` claim is what relying parties (e.g. the proxy's
`app_auth__adminGroups`) use to map group membership to roles.

## Token lifetimes

Defaults (overridable per-client via `token_lifetime`, or globally via
`app_oauth__token_lifetime__access_token` /
`app_oauth__token_lifetime__refresh_token`):

- access token: 3600s (1 hour)
- refresh token: 2592000s (30 days)

## Admin gating

SSO admin actions are gated by LDAP group membership (checked via the group's
`member` list, not `memberOf` on the user):

- `app_sso_admin` — full admin (users, groups, settings).
- `app_sso_oauth_admin` — OAuth client management.
- `app_sso_invite` — invitation management.

The bootstrap in [theta-env](https://github.com/theta42/theta-env) creates your
first admin and adds them to `app_sso_admin` + `app_sso_oauth_admin`
automatically; for a standalone install, add the admin's DN to those groups
manually (or via `ops/ldap-setup.sh`).

## JWT signing

Tokens are signed with `conf.oauth.jwtSecret` (`app_oauth__jwtSecret` /
`JWT_SECRET`). **Persist this secret** — if it changes, every issued token
stops validating. The all-in-one Docker image auto-generates one if none is set,
but that generated value does not survive container recreation unless you
persist it (set `JWT_SECRET` in your `.env`).

[← Back to Home](index.html)