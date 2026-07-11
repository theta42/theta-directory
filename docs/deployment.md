---
layout: default
title: Deployment
---

# Deployment Guide

[← Back to Home](index.html)

Two supported methods:

1. **Docker** — a single all-in-one image bundling the app + OpenLDAP + Redis.
2. **Bare metal** — `install.sh` on Debian/Ubuntu (Node.js, OpenLDAP, Redis, systemd unit).

## Method 1: Docker (all-in-one)

The image (`Dockerfile.openldap`) bundles OpenLDAP + the app + Redis in one
container. The app connects to the bundled slapd over `localhost:389`
automatically; you only need to set a few secrets.

```bash
# Minimal: an LDAP admin password + a JWT secret, then build + start.
LDAP_ADMIN_PASS='choose-a-strong-password' \
JWT_SECRET="$(openssl rand -hex 32)" \
docker compose up -d --build
```

For a customized deployment, put overrides in a `.env` next to
`docker-compose.yml`:

```env
LDAP_BASE_DN=dc=yourdomain,dc=com
LDAP_DOMAIN=yourdomain.com
LDAP_ADMIN_PASS=your-admin-password
ORG_NAME=Your Org
JWT_SECRET=your-jwt-secret
OAUTH_ISSUER=https://sso.yourdomain.com   # browser-facing URL the proxy serves
LDAP_CERT_CN=sso.yourdomain.com            # hostname LDAPS clients verify
SMTP_HOST=smtp.yourdomain.com
SMTP_PORT=587
SMTP_USER=noreply@yourdomain.com
SMTP_PASS=your-smtp-password
SMTP_FROM=Your Org <noreply@yourdomain.com>
PORT=3001
LDAPS_PORT=636
```

Then `docker compose up -d --build`.

### Access

- SSO Manager UI: `http://localhost:3001` (HTTP — put a TLS-terminating proxy in front)
- Health: `http://localhost:3001/health` → `{"status":"ok"}`
- OIDC discovery: `http://localhost:3001/.well-known/openid-configuration`
- LDAPS (legacy apps / direct binds): `ldaps://<host>:636`

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LDAP_BASE_DN` | `dc=example,dc=com` | slapd suffix + app user/group base |
| `LDAP_DOMAIN` | derived from base DN | DNS domain; default for cert CN + issuer |
| `LDAP_ADMIN_PASS` | `admin` | slapd root password + app bind password |
| `ORG_NAME` | `SSO Manager` | org name in UI/email/group descriptions |
| `JWT_SECRET` | auto-generated | OAuth JWT signing secret (**persist it**) |
| `OAUTH_ISSUER` | `https://sso.<LDAP_DOMAIN>` | OIDC issuer (browser-facing URL) |
| `LDAP_CERT_CN` | `LDAP_DOMAIN` | CN/SAN on the LDAPS cert |
| `LDAP_CERT_DIR` | `/etc/openldap/certs` | look for `ldap.crt`+`ldap.key` here (mount your own) |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` | localhost / 587 / empty | outbound email |
| `PORT` | `3001` | host port mapped to the UI |
| `LDAPS_PORT` | `636` | host port mapped to LDAPS |

Any `app_*` var may also be set directly to override any config value — see
[Configuration](configuration.html).

### LDAP TLS (LDAPS / StartTLS)

The bundled slapd generates a **self-signed cert** on first start (CN =
`LDAP_CERT_CN`, valid 10y, SAN = CN + `localhost` + `127.0.0.1`) and listens on
`ldaps:///` (636) + StartTLS on `ldap:///` (389). The cert lives on the
`ldap-certs` volume so it persists across container recreation.

- **Trust it** (clients): copy the cert out and add it to the client's CA store,
  or set `TLS_REQCERT never` for quick LAN use:
  ```bash
  docker compose cp sso-manager:/etc/openldap/certs/ldap.crt ./ldap.crt
  ```
- **Use your own cert**: replace the `ldap-certs` named volume with a bind mount
  containing your `ldap.crt` + `ldap.key`. The entrypoint leaves existing certs
  untouched.

> Port 389 (plain LDAP) is **not** mapped to the host by default — direct-LDAP
> clients should use LDAPS (636) or StartTLS.

### Backups (~100 users)

```bash
docker compose exec sso-manager slapcat -f /etc/openldap/slapd.conf \
  -b "dc=yourdomain,dc=com" > ldap-backup-$(date +%F).ldif
```

Restorable with `ldapadd`/`ldapmodify` against a fresh instance. Redis is
in-memory (session/cache only — safe to lose). Persist `JWT_SECRET` +
`LDAP_ADMIN_PASS` outside the container (your `.env`, a password manager).

## Method 2: Bare metal (Debian/Ubuntu)

`install.sh` is an idempotent installer: Node.js 20.x, OpenLDAP (modules +
overlays + custom schema + directory tree + required groups), the app at
`/opt/sso-manager`, and a systemd unit.

```bash
sudo ./install.sh \
  -p 'your-ldap-password' \
  -b 'dc=yourdomain,dc=com' \
  -n 'Your Org' \
  -o 3001
```

| Flag | Description |
|------|-------------|
| `-p, --admin-pass` | LDAP admin password (required) |
| `-b, --base-dn` | Base DN (default `dc=example,dc=com`) |
| `-n, --org-name` | Org name (default `SSO Manager`) |
| `-o, --port` | HTTP port (default `3001`) |
| `-j, --jwt-secret` | JWT secret (default auto-generated) |
| `-s, --smtp-config` | SMTP as `host:port:user:pass` |
| `--skip-ldap` | Skip LDAP setup (use existing) |
| `--skip-app` | LDAP setup only |
| `--dry-run` | Show actions without making changes |

Post-install:

```bash
sudo systemctl enable --now sso-manager
curl http://localhost:3001/health    # -> {"status":"ok"}
```

For an existing LDAP server, run `sudo ./install.sh --skip-ldap …` and point the
app at it. To (re)configure overlays on an already-installed slapd, prefer
`ops/ldap-setup.sh` (idempotent, auto-detects the user database).

## Fronting with a reverse proxy

The SSO runs HTTP inside the container; terminate TLS at a front proxy. The
[`theta42/proxy`](https://github.com/theta42/proxy) is an OIDC-protected reverse
proxy and a natural fit — it's **both** an OIDC client of this SSO *and* a
direct LDAP client for user lookups.

1. **One Docker network** so the proxy reaches the SSO internally at
   `http://sso-manager:3001` (token/userinfo, server-to-server) without exposing
   the SSO's HTTP port.
2. **Set the SSO's `OAUTH_ISSUER`** to the *browser-facing* HTTPS URL the proxy
   serves the SSO at (e.g. `https://sso.yourdomain.com`).
3. **Register the proxy as an OIDC client** in the SSO UI, with `redirectUri`
   matching the proxy's callback (`https://proxy.yourdomain.com/api/auth/oidc/callback`).
4. **LDAP for the proxy**: point `ldap.url` at `ldaps://sso-manager:636` and
   create a dedicated service account under `ou=people` (e.g.
   `cn=ldapclient,ou=people,…`) — don't reuse the admin DN.

The [`theta42/theta-env`](https://github.com/theta42/theta-env) unified repo
automates all four steps with `./setup.sh` — see
[theta-env docs](https://theta42.github.io/theta-env/).

## Security notes

1. **Never commit `secrets.js`** — it's in `.gitignore`.
2. **Use LDAPS / StartTLS** for any LDAP that crosses the network. Port 389 is
   not mapped to the host by default so LAN clients can't bind in cleartext.
3. **Persist `JWT_SECRET`** — an auto-generated one invalidates all tokens on
   container recreation.
4. **Don't expose the UI's HTTP port to the internet** — terminate TLS at a
   front proxy and keep `3001` on the Docker network / localhost only.
5. The all-in-one image runs slapd as the `ldap` user but the app as root
   (matches the bare-metal unit). Harden to a non-root user for production.

[← Back to Home](index.html)