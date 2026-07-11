# Deployment Guide — SSO Manager

Two supported deployment methods:

1. **Docker** — a single all-in-one image bundling the app + OpenLDAP (`docker compose up`).
2. **Bare metal** — `install.sh` on Debian/Ubuntu (installs Node.js, OpenLDAP, the app, and a systemd unit).

## How configuration works

The app loads configuration via [`@simpleworkjs/conf`](https://www.npmjs.com/package/@simpleworkjs/conf), which deep-merges, in order:

1. `conf/base.js` (committed, generic defaults)
2. `conf/<NODE_ENV>.js` (optional)
3. `conf/secrets.js` (gitignored — secrets + per-deployment values)
4. **`app_*` environment variables** — the highest-precedence layer

Any env var whose name starts with `app_` overrides the merged config. The rest
of the name is split on **double-underscore** (`__`) into a nested path. Values
are `JSON.parse`-coerced when possible (numbers, booleans, null, JSON) and kept
as raw strings otherwise. Examples:

| Env var | Sets | Type |
|---------|------|------|
| `app_ldap__url=ldap://host:389` | `conf.ldap.url` | string |
| `app_ldap__bindPassword=secret` | `conf.ldap.bindPassword` | string |
| `app_oauth__jwtSecret=...` | `conf.oauth.jwtSecret` | string |
| `app_smtp__secure=false` | `conf.smtp.secure` | boolean |
| `app_oauth__token_lifetime__access_token=3600` | `conf.oauth.token_lifetime.access_token` | number |
| `app_name=My SSO` | `conf.name` | string |

> **Requires `@simpleworkjs/conf` >= 1.1.0.** The Docker image will not honor
> `app_*` env vars on 1.0.0. Before building the image, refresh the app's
> dependency lock from the `nodejs/` directory:
> ```bash
> cd nodejs && npm install @simpleworkjs/conf@^1.1.0
> ```

---

## Method 1: Docker (all-in-one)

The image (`Dockerfile.openldap`) bundles OpenLDAP and the app in one container.
The app connects to the bundled slapd over `localhost:389` automatically; you only
need to set a few secrets.

### Setup

```bash
# Minimal: set an LDAP admin password and a JWT secret, then build + start.
LDAP_ADMIN_PASS='choose-a-strong-password' \
JWT_SECRET="$(openssl rand -hex 32)" \
docker compose up -d --build
```

For a customized deployment, put the overrides in a `.env` file next to
`docker-compose.yml`:

```env
LDAP_BASE_DN=dc=yourdomain,dc=com
LDAP_DOMAIN=yourdomain.com
LDAP_ADMIN_PASS=your-admin-password
ORG_NAME=Your Org
JWT_SECRET=your-jwt-secret
OAUTH_ISSUER=https://sso.yourdomain.com   # browser-facing URL the proxy serves
LDAP_CERT_CN=sso.yourdomain.com           # hostname LDAPS clients verify against
SMTP_HOST=smtp.yourdomain.com
SMTP_PORT=587
SMTP_USER=noreply@yourdomain.com
SMTP_PASS=your-smtp-password
SMTP_FROM=Your Org <noreply@yourdomain.com>
PORT=3001
LDAPS_PORT=636
# LDAP_PORT=389   # uncomment the 389 host mapping in compose if you need plain LAN binds
```

Then `docker compose up -d --build`.

### What the entrypoint does

`docker-entrypoint.sh` (run as the container entrypoint):

1. Generates a self-signed TLS cert (unless one is already present at
   `LDAP_CERT_DIR`), generates a `slapd.conf` for the bundled OpenLDAP (`mdb`
   database, `pw-sha2`/`ppolicy`/`memberof`/`refint` modules + overlays, TLS,
   indexes, access controls), and starts `slapd -f /etc/openldap/slapd.conf`
   listening on `ldap:///` (389) and `ldaps:///` (636).
2. Seeds the directory (base DN, `ou=people`/`ou=groups`/`ou=policies`, a default
   `pwdPolicy`, and the required SSO groups `app_sso_admin`, `app_sso_invite`,
   `app_sso_oauth_admin`) — idempotently, so container restarts are safe.
3. Starts a bundled Redis (the app uses `model-redis` for models/sessions), unless
   `app_redis__host` is set (then it's expected to be external).
4. Exports `app_*` env vars so the app binds to the local slapd (any `app_*` you
   set in the compose environment wins over the entrypoint's defaults).
5. `exec`s `node bin/www`.

### Access

- SSO Manager UI: `http://localhost:3001` (HTTP inside the container — put a TLS-terminating proxy in front for browser access)
- Health check: `http://localhost:3001/health` → `{"status":"ok"}`
- OIDC discovery: `http://localhost:3001/.well-known/openid-configuration`
- LDAP (internal, app↔slapd): `ldap://localhost:389` (not mapped to the host)
- LDAPS (for legacy apps / direct binds): `ldaps://<host>:636` (TLS)

### Available environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LDAP_BASE_DN` | `dc=example,dc=com` | slapd suffix + app user/group base |
| `LDAP_DOMAIN` | derived from `LDAP_BASE_DN` | DNS domain; default for `LDAP_CERT_CN` and OAuth issuer |
| `LDAP_ADMIN_PASS` | `admin` | slapd root password + app bind password |
| `ORG_NAME` | `SSO Manager` | org name in UI/email/group descriptions |
| `JWT_SECRET` | auto-generated | OAuth JWT signing secret (persist it!) |
| `OAUTH_ISSUER` | `https://sso.<LDAP_DOMAIN>` | OIDC issuer in the discovery doc (browser-facing URL) |
| `LDAP_CERT_CN` | `LDAP_DOMAIN` | CN/SAN on the LDAPS cert (hostname clients verify against) |
| `LDAP_CERT_DIR` | `/etc/openldap/certs` | where the entrypoint looks for `ldap.crt`+`ldap.key` (mount your own here) |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` | localhost / 587 / empty | outbound email |
| `PORT` | `3001` | host port mapped to the UI |
| `LDAPS_PORT` | `636` | host port mapped to LDAPS |
| `LDAP_PORT` | `389` | uncomment the host mapping in compose to expose plain LDAP (not recommended) |

Any `app_*` var may also be set directly to override any config value (see the
table at the top).

### LDAP TLS (LDAPS / StartTLS)

The bundled slapd generates a **self-signed cert** on first start (CN = `LDAP_CERT_CN`,
valid 10 years, SAN includes the CN + `localhost` + `127.0.0.1`) and listens on
`ldaps:///` (636) plus offers StartTLS on `ldap:///` (389). The cert is stored on the
`ldap-certs` volume so it persists across container recreation — clients don't need
to re-trust on every rebuild.

- **Trusting the self-signed cert** (clients): copy `/etc/openldap/certs/ldap.crt`
  out of the container and add it to the client's trusted CA store, or set
  `TLS_REQCERT never` for quick-and-dirty LAN use. Fetch it with:
  ```bash
  docker compose cp sso-manager:/etc/openldap/certs/ldap.crt ./ldap.crt
  ```
- **Use your own cert** (CA-signed / internal CA): replace the `ldap-certs` named
  volume with a bind mount containing your own `ldap.crt` + `ldap.key`:
  ```yaml
  volumes:
    - ./certs:/etc/openldap/certs   # must contain ldap.crt + ldap.key
  ```
  The entrypoint leaves existing certs untouched (idempotent).

> Port 389 (plain LDAP) is **not** mapped to the host by default, to avoid cleartext
> password binds over the LAN. Direct-LDAP clients should use LDAPS (636) or
> StartTLS. Uncomment the `389` mapping in `docker-compose.yml` only if you need
> plain LAN binds and accept the risk.

### Fronting with a reverse proxy (theta42/proxy)

The SSO Manager runs HTTP inside the container; terminate TLS at a front proxy.
The [`theta42/proxy`](https://github.com/theta42/proxy) is an OIDC-protected reverse
proxy and a natural fit — it's both an **OIDC client** of the SSO Manager *and* a
**direct LDAP client** for user lookups. To run both together:

1. **Put them on one Docker network** so the proxy can reach the SSO Manager
   internally at `http://sso-manager:3001` for token/userinfo (server-to-server),
   without exposing the SSO Manager's HTTP port to the internet:
   ```yaml
   # in the proxy's compose, or a shared external network:
   networks:
     - sso-net
   ```
2. **Set the SSO's `OAUTH_ISSUER`** to the *browser-facing* HTTPS URL the proxy
   serves the SSO at (e.g. `https://sso.yourdomain.com`). The proxy's
   `oidc.issuer`/endpoints must match — it can get them from the SSO's
   `/.well-known/openid-configuration`. Server-to-server calls from the proxy go to
   the internal `http://sso-manager:3001` URL; only the issuer/redirect URLs must
   be public.
3. **Register the proxy as an OAuth/OIDC client** in the SSO Manager UI, with a
   `redirectUri` matching the proxy's callback (e.g.
   `https://proxy.yourdomain.com/api/auth/oidc/callback`), and put the client
   secret in the proxy's `secrets.js`.
4. **LDAP for the proxy**: point the proxy's `ldap.url` at
   `ldaps://sso-manager:636` (TLS, same Docker network) rather than a LAN IP, and
   create a dedicated LDAP service account under `ou=people` (e.g.
   `cn=ldapclient,ou=people,…`) via the SSO Manager UI — don't reuse the admin DN.

### Backups (small-business / ~100 users)

- **LDAP data** lives on the `ldap-data` volume (`/var/lib/ldap` in the container).
  Back up the directory with an `ldapsearch`/`slapcat` export on a schedule:
  ```bash
  docker compose exec sso-manager slapcat -f /etc/openldap/slapd.conf \
    -b "dc=yourdomain,dc=com" > ldap-backup-$(date +%F).ldif
  ```
  (Restorable with `ldapadd`/`ldapmodify` against a fresh instance.)
- **Redis** is in-memory and not persisted by default (session/cache only — safe
  to lose). If you want session durability, mount a Redis AOF/RDB volume and
  enable persistence in `docker-entrypoint.sh`.
- **JWT_SECRET** and **LDAP_ADMIN_PASS** are operational secrets — store them
  outside the container (your `.env`, a password manager, etc.).

---

## Method 2: Bare metal (Debian/Ubuntu)

`install.sh` is an idempotent installer: it installs Node.js 20.x, installs and
configures OpenLDAP (modules + overlays + custom schema + directory tree +
required groups), deploys the app to `/opt/sso-manager`, and creates a systemd
unit. Configuration is written to `/opt/sso-manager/conf/secrets.js` (file-based).

### Prerequisites

- Debian 11+ / Ubuntu 20.04+
- Root (`sudo`)
- Internet access

### Install

```bash
sudo ./install.sh \
  -p 'your-ldap-password' \
  -b 'dc=yourdomain,dc=com' \
  -n 'Your Org' \
  -o 3001
```

| Flag | Env var | Description |
|------|---------|-------------|
| `-p, --admin-pass` | `LDAP_ADMIN_PASS` | LDAP admin password (required) |
| `-b, --base-dn` | `LDAP_BASE_DN` | Base DN (default `dc=example,dc=com`) |
| `-n, --org-name` | `ORG_NAME` | Org name (default `SSO Manager`) |
| `-o, --port` | `PORT` | HTTP port (default `3001`) |
| `-j, --jwt-secret` | `JWT_SECRET` | JWT secret (default auto-generated) |
| `-s, --smtp-config` | `SMTP_*` | SMTP as `host:port:user:pass` |
| `--skip-ldap` | `SKIP_LDAP` | Skip LDAP setup (use existing) |
| `--skip-app` | `SKIP_APP` | LDAP setup only |
| `--dry-run` | `DRY_RUN` | Show actions without making changes |

### Post-install

```bash
sudo systemctl enable --now sso-manager
journalctl -fu sso-manager
curl http://localhost:3001/health    # -> {"status":"ok"}
```

### What `install.sh` does

1. Installs Node.js 20.x (NodeSource).
2. Installs OpenLDAP (`slapd`) with: `pw-sha2`, `ppolicy`, `memberof`, `refint`
   modules + overlays; the custom `theta42Person` schema (`dateOfBirth`); indexes;
   `ou=people`/`ou=groups`/`ou=policies`; a default `pwdPolicy`; and the SSO groups.
3. Installs the app to `/opt/sso-manager` and runs `npm ci --omit=dev`.
4. Generates `conf/secrets.js` (LDAP/SMTP/JWT) and `conf/base.js` (generic defaults).
5. Installs `sso-manager.service` (systemd), enabled on boot.

> For an existing LDAP server, run `sudo ./install.sh --skip-ldap …` and point the
> app at it. For LDAP-only setup on a host that already runs the app elsewhere, use
> `--skip-app`. To (re)configure overlays on an already-installed slapd, prefer
> `ops/ldap-setup.sh` (idempotent, auto-detects the user database).

---

## LDAP requirements (for any external LDAP server)

The app needs these on the LDAP server:

- **Modules:** `pw-sha2` (the app stores user passwords as `{SSHA512}`), `ppolicy`,
  `memberof`, `refint`.
- **Custom schema:** the `theta42Person` auxiliary objectClass with `dateOfBirth`
  (OID `1.3.6.1.4.1.99999.x`) — see `ops/ldap-setup.sh` for the LDIF.
- **Directory tree:** `ou=people`, `ou=groups`, `ou=policies` under the base DN, a
  default `pwdPolicy` at `cn=ppolicy,ou=policies,<base>`.
- **Required groups:** `app_sso_admin` (full admin), `app_sso_invite` (invitation
  management), `app_sso_oauth_admin` (OAuth client management).

`ops/ldap-setup.sh -p <admin-password>` configures all of the above idempotently
against a running slapd (auto-detects the database holding your base DN, and
verifies `pwdAccountLockedTime` is live — the attribute the app's
active/inactive toggle depends on).

---

## Migrating an existing instance to the generic defaults

The committed `nodejs/conf/base.js` now ships **generic** defaults
(`dc=example,dc=com`, `localhost`, `SSO Manager`). Previously it carried
Theta42-specific values (LDAP bind DN/bases, SMTP host/user/sender, OAuth issuer).
If you run an existing instance off this repo:

- Move those per-deployment, non-secret values (bind DN, user/group bases, SMTP
  host/user/sender, OAuth issuer, org name) from `base.js` into your gitignored
  `conf/secrets.js`, **or** set them as `app_*` env vars. Secret values (LDAP bind
  password, SMTP password, JWT secret) already belong in `secrets.js`.
- After the change, verify the merged config: `node -e "console.log(require('@simpleworkjs/conf'))"` from the `nodejs/` directory.

---

## Troubleshooting

### `503 OpenLDAP ppolicy overlay is not configured`
The ppolicy overlay isn't attached to the database holding your users, so the
active/inactive toggle can't set `pwdAccountLockedTime`. Run:
```bash
sudo ./ops/ldap-setup.sh -p 'admin-password' -b dc=yourdomain,dc=com
```

### App starts but LDAP operations 401 / "Invalid Credentials"
Check the merged LDAP config the app actually sees:
```bash
cd nodejs && node -e "console.log(require('@simpleworkjs/conf').ldap)"
```
Confirm `url`/`bindDN`/`bindPassword`/`userBase` match your directory. Remember
`app_*` env vars override `secrets.js` which overrides `base.js`.

### `app_*` env vars seem to do nothing
You're on `@simpleworkjs/conf` 1.0.0. Bump to 1.1.0+:
```bash
cd nodejs && npm install @simpleworkjs/conf@^1.1.0
```

### LDAP connection refused
```bash
docker compose exec sso-manager sh -c 'ldapsearch -x -H ldap://localhost:389 -b "" -s base'
systemctl status slapd   # bare metal
netstat -tlnp | grep 389
```

---

## Security notes

1. **Never commit `secrets.js`** — it's in `.gitignore`.
2. **Use LDAPS / StartTLS** for any LDAP connection that crosses the network. The
   bundled slapd listens on `ldaps:///` (636, TLS) and `ldap:///` (389, plain +
   StartTLS); port 389 is not mapped to the host by default so LAN clients can't
   bind in cleartext. Direct-LDAP apps (legacy services, `theta42/proxy`) should
   use `ldaps://…:636` or StartTLS.
3. **Persist `JWT_SECRET`** — if the Docker image auto-generates one and you don't
   set `JWT_SECRET`, issued tokens invalidate on container recreation.
4. **Don't expose the UI's HTTP port to the internet** — terminate TLS at a front
   proxy and keep `3001` on the Docker network / localhost only.
5. The all-in-one image runs slapd as the `ldap` user but the app process as root
   (matches the bare-metal systemd unit). Harden the app to a non-root user for
   production if needed.