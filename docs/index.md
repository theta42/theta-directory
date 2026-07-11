---
layout: default
title: Home
---

# SSO Manager

A self-hosted **OpenID Connect provider** with a bundled **OpenLDAP directory**
and a web management UI — for home labs and small businesses that want their
own identity provider instead of a hosted one.

## Features

- **OpenID Connect / OAuth 2.0 provider** — issue your own access/refresh/id
  tokens; protect your apps with OIDC login.
- **OpenLDAP directory** — users, groups, POSIX accounts (`posixAccount`/
  `inetOrgPerson`), SSH public keys, and sudo roles, with `memberOf` +
  referential-integrity overlays.
- **Web management UI** — manage users, groups, and OAuth clients from a
  browser; invite/password-reset flows over email.
- **LDAPS for legacy apps** — apps that bind LDAP directly (Gitea, Emby, …)
  can use LDAPS (636) / StartTLS.
- **All-in-one Docker image** — app + OpenLDAP + Redis in one container, or
  run each piece separately via `app_*` env config.

## Quick Start

### Docker (all-in-one)

```bash
git clone https://github.com/theta42/sso-manager-node.git
cd sso-manager-node
cp secrets.js.example nodejs/conf/secrets.js   # edit it, or use app_* env
docker compose up -d --build
```

The web UI comes up at `http://localhost:3001`. See the
[Deployment Guide](deployment.html) for the full set of `app_*` env vars.

### Bare metal (Debian/Ubuntu)

```bash
sudo ./install.sh
```

Idempotent installer — installs Node.js, OpenLDAP, Redis, configures the app,
and starts a systemd unit. Re-run to update.

### Run it together with the proxy

The proxy ([theta42/proxy](https://github.com/theta42/proxy)) fronts this SSO
under TLS and protects it with OIDC, while also binding LDAP directly. Run both
with one command via [theta-env](https://github.com/theta42/theta-env):

```bash
git clone --recursive https://github.com/theta42/theta-env.git
cd theta-env && cp .env.example .env   # edit, then:
./setup.sh
```

## Documentation

- [Deployment Guide](deployment.html) — Docker + bare metal, the config layers,
  the `app_*` env reference, backups.
- [Configuration](configuration.html) — every `app_*` env var and the conf
  merge order.
- [OAuth / OIDC](oauth.html) — the provider: discovery, client management,
  token lifetimes, scopes.
- [LDAP](ldap.html) — directory layout, TLS, overlays, schema, direct-bind
  service accounts.

## Architecture

```
┌─────────────┐
│  Browser /  │
│  OIDC apps  │
└──────┬──────┘
       │ HTTP/HTTPS
       ▼
┌────────────────────────┐      ┌─────────────┐
│  Express SSO Manager   │◄────►│   Redis     │
│  - OIDC provider       │      │ - sessions  │
│  - web UI (:3001)      │      │ - models    │
│  - management API      │      └─────────────┘
└────────┬───────────────┘
         │ ldapi/ldap (localhost)
         ▼
┌────────────────────────┐
│  OpenLDAP (slapd)      │
│  - users / groups      │
│  - LDAPS :636          │─── legacy apps bind directly
│  - StartTLS :389       │
└────────────────────────┘
```

## Community

- [GitHub Repository](https://github.com/theta42/sso-manager-node)
- [Issue Tracker](https://github.com/theta42/sso-manager-node/issues)
- [Pull Requests](https://github.com/theta42/sso-manager-node/pulls)

## License

MIT License — see the repository for details.