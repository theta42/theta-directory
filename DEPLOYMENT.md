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

The bundled `docker-compose.yml` reads config from a bind-mounted
`./config/sso-secrets.js` (not from a `.env` file). Copy the example, fill in
your secrets, then build + start:

```bash
mkdir -p config && chmod 700 config
cp secrets.js.example config/sso-secrets.js
$EDITOR config/sso-secrets.js     # set ldap.bindPassword, oauth.jwtSecret, ...
docker compose up -d --build
```

`docker-entrypoint.sh` symlinks `/config/sso-secrets.js` → `/app/conf/secrets.js`
so `@simpleworkjs/conf` reads it, and pulls the server-side LDAP vars (base DN,
admin password, org, domain, cert CN, JWT secret) out of the same file. No
`app_*` env is passed — `app_*` env would override `secrets.js` (env beats the
file in `@simpleworkjs/conf`), so the file is kept authoritative.

> Running the unified `theta-env` stack? Its `setup.sh` generates
> `./config/sso-secrets.js` (+ `./config/proxy-secrets.js`) for you with random
> secrets and snapshots state before rebuilds — see the theta-env README.

**Quick test (defaults):** with no `./config/sso-secrets.js` the entrypoint
falls back to env-mode with safe defaults (`dc=example,dc=com`, admin password
`admin`, an auto-generated JWT secret) — fine for kicking the tires, not for
production.

**Advanced — env vars instead of the file:** the entrypoint also supports
config via `LDAP_*` / `app_*` env vars (env-mode, used when
`/config/sso-secrets.js` is absent). Since the bundled compose no longer passes
those env vars, you'd add them to its `environment:` block yourself, e.g.
`LDAP_ADMIN_PASS`, `JWT_SECRET`, `app_oauth__issuer`. This is mainly for
bare-metal / advanced standalone use; most deployments should use the file.

### What the entrypoint does

`docker-entrypoint.sh` (run as the container entrypoint):

1. If `/config/sso-secrets.js` is mounted, symlinks it to `/app/conf/secrets.js`
   and reads the server-side LDAP vars from it (secrets.js mode). Otherwise it
   derives them from `LDAP_*` env vars with safe defaults (env mode).
2. Generates a self-signed TLS cert (unless one is already present at
   `LDAP_CERT_DIR`), generates a `slapd.conf` for the bundled OpenLDAP (`mdb`
   database, `pw-sha2`/`ppolicy`/`memberof`/`refint` modules + overlays, TLS,
   indexes, access controls), and starts `slapd -f /etc/openldap/slapd.conf`
   listening on `ldap:///` (389) and `ldaps:///` (636).
3. Seeds the directory (base DN, `ou=people`/`ou=groups`/`ou=policies`, a default
   `pwdPolicy`, and the required SSO groups `app_sso_admin`, `app_sso_invite`,
   `app_sso_oauth_admin`) — idempotently, so container restarts are safe.
4. Starts a bundled Redis (the app uses `model-redis` for models/sessions and
   stores OAuth clients there), AOF+RDB persisted to `/data`, unless
   `app_redis__host` is set (then it's expected to be external).
5. In env mode, exports `app_*` env vars so the app binds to the local slapd. In
   secrets.js mode it exports none (the app reads the file directly).
6. `exec`s `node bin/www`.

### Access

- SSO Manager UI: `http://localhost:3001` (HTTP inside the container — put a TLS-terminating proxy in front for browser access)
- Health check: `http://localhost:3001/health` → `{"status":"ok"}`
- OIDC discovery: `http://localhost:3001/.well-known/openid-configuration`
- LDAP (internal, app↔slapd): `ldap://localhost:389` (not mapped to the host)
- LDAPS (for legacy apps / direct binds): `ldaps://<host>:636` (TLS)

### API tokens (personal access tokens)

Any logged-in user can mint a long-lived bearer token to call the management
API from scripts/CI/other services, without a browser session. Tokens are
self-service and authenticate **as their creator** — a token carries the
creator's LDAP group permissions, so the same `permission.byGroup` checks apply
(group membership is re-resolved from LDAP live on each request).

Create one in the UI under **API Tokens** (the token string is shown **once**),
then use it as a bearer token:

```bash
curl -H "Authorization: Bearer sso_<id>_<secret>" https://sso.example.com/api/user
```

Format: `sso_<id>_<secret>` — the `id` is the lookup key, the `secret` is
bcrypt-hashed and never stored in plaintext. Rotate or revoke a token from the
same UI page; revocation takes effect immediately. Optional expiry (in days) at
creation. API tokens persist in the bundled Redis, so they survive rebuilds
(Redis is persisted via AOF — see *Backups and restore*).

The token has the same access as a browser session for that user — an
`app_sso_admin`'s token can manage users/groups; a non-admin's token is limited
to what they could do in the UI.

### Logs

The all-in-one image runs the Node app and slapd (OpenLDAP) in one container,
both writing to the container's stdout/stderr, so `docker compose logs` is the
primary view (slapd runs with `-d 0`, so LDAP output is there too).

```bash
docker compose logs -f sso-manager                       # app + slapd (stdout/stderr)
docker compose logs --tail=200 --since=10m sso-manager   # recent context
docker compose exec sso-manager ldapsearch -x -H ldap://localhost:389 \
  -D "cn=admin,$LDAP_BASE_DN" -W -b "$LDAP_BASE_DN"       # LDAP health check
```

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

### Backups and restore

**What lives where**

| State | Location | Persisted? |
|-------|----------|------------|
| LDAP directory (users, groups, policies) | `ldap-data` volume (`/var/lib/ldap`) | yes (volume) |
| LDAP TLS cert | `ldap-certs` volume (`/etc/openldap/certs`) | yes (volume) |
| Redis (OAuth clients, tokens, sessions) | `sso-data` volume (`/data`) | yes (AOF + RDB) |
| Secrets (LDAP admin pass, JWT secret, SMTP) | `./config/sso-secrets.js` (bind mount) | your responsibility — back up off-host |

**Automatic snapshots** — when run as part of the unified `theta-env` stack,
`setup.sh` snapshots LDAP + Redis + `./config/` to `./backups/<timestamp>/`
before every rebuild and keeps the last `BACKUP_KEEP` (default 5). Standalone
deployments don't get this; use the manual steps below.

**Manual backup**

```bash
# LDAP — full directory export (works while slapd is running)
docker compose exec sso-manager slapcat -f /etc/openldap/slapd.conf \
  -b "dc=yourdomain,dc=com" > ldap-backup-$(date +%F).ldif

# Redis — hot snapshot: trigger a save, then copy the RDB out
docker compose exec sso-manager redis-cli BGSAVE
docker compose cp sso-manager:/data/dump.rdb sso-redis-$(date +%F).rdb

# Secrets — copy the config dir (holds LDAP_ADMIN_PASS, JWT secret, etc.)
cp -a ./config config-backup-$(date +%F) && chmod 700 config-backup-$(date +%F)
```
Store the `.ldif`, `.rdb`, and config copy **off the host** — they contain
secrets and the whole user directory.

**Restore — full (disaster recovery)**

The SSO image uses a static `slapd.conf` (slapd starts with `-f`, not `-F`
cn=config), so LDAP restore uses `slapadd -f /etc/openldap/slapd.conf`:

```bash
# 1. Secrets
cp -a config-backup-<date> ./config && chmod 700 ./config
./setup.sh                       # fresh empty volumes (or: docker compose up -d)
docker compose stop sso-manager

# 2. LDAP — wipe the mdb files, then load the LDIF into the stopped directory
docker compose run --rm --no-deps --entrypoint sh sso-manager -c \
  'rm -f /var/lib/ldap/* && slapadd -f /etc/openldap/slapd.conf -l /dev/stdin' \
  < ldap-backup-<date>.ldif
docker compose start sso-manager

# 3. Redis — see the AOF note below
docker compose stop sso-manager
docker compose run --rm --no-deps --entrypoint sh sso-manager -c \
  'rm -f /data/appendonly.aof /data/appendonly.aof.*'   # REQUIRED — see note
docker compose cp sso-redis-<date>.rdb sso-manager:/data/dump.rdb
docker compose start sso-manager
```

**Restore — Redis only** = step 3 above. **Restore — LDAP only** = step 2 above.

> **AOF vs RDB (important):** with `--appendonly yes`, Redis loads
> `appendonly.aof` on startup and **ignores** `dump.rdb` if the AOF exists. To
> restore from an RDB snapshot you **must delete the AOF first** (step 3 does
> this); Redis then loads the RDB and writes a fresh AOF. Verify after restoring:
> `docker compose exec sso-manager redis-cli DBSIZE` and
> `docker compose exec sso-manager ldapsearch -x -b "dc=yourdomain,dc=com"`.

**Upgrades**

```bash
./setup.sh          # backs up, then rebuilds — volumes keep LDAP + Redis state
# (standalone) docker compose pull && docker compose up -d
```
LDAP data and Redis state survive the rebuild because they live on named
volumes, not in the image. Verify health (`docker compose ps`, log in, check an
OAuth client). Note: re-running bootstrap resets the bootstrap-admin and
service-account passwords to the values in `./config/sso-secrets.js`; non-theta
OAuth clients live in SSO Redis and are preserved by the volume.

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