---
layout: default
title: LDAP
---

# LDAP Directory

[← Back to Home](index.html)

SSO Manager runs an OpenLDAP directory holding your users and groups. The app
authenticates against it over `localhost:389` (inside the all-in-one container)
and exposes **LDAPS** (`ldaps://…:636`, TLS) for legacy apps that bind LDAP
directly — Gitea, Emby, the theta42/proxy, etc.

## Directory layout

```
dc=yourdomain,dc=com
├── ou=people          users (inetOrgPerson + posixAccount + …)
├── ou=groups          groups (groupOfNames)
└── ou=policies        password policies (pwdPolicy)
    └── cn=ppolicy     default policy
```

### Users

User entries are `cn=<uid>,ou=people,<base>` and carry the objectClasses:

- `inetOrgPerson` (cn, sn, mail, …) — identity / contact attrs.
- `posixAccount` (uid, uidNumber, gidNumber, homeDirectory) — the SSO's
  `userFilter` is `(objectClass=posixAccount)`, so a user is "a real account"
  iff it has `posixAccount`.
- `ldapPublicKey` — SSH public keys (`sshPublicKey`).
- `sudoRole` — per-user sudo rules (`sudoCommand`, `sudoHost`, `sudoUser`).
- `theta42Person` (custom auxiliary; `dateOfBirth`).

Passwords are stored as `{SSHA512}` (8-byte salt, sha512(pass+salt), base64),
verified by the `pw-sha2` module. The app's `hashPasswordSSHA512` is the
canonical hasher; if you provision users out-of-band, hash passwords the same
way or use `slappasswd -h '{SSHA512}'`.

### Groups

Groups are `cn=<name>,ou=groups,<base>` (`groupOfNames`) with a `member`
attribute listing member DNs. The `memberOf` overlay populates reverse
membership (`memberOf` on the user); `refint` keeps it consistent on
add/remove. **Admin permission checks read the group's `member` list**, not
`memberOf` on the user.

The SSO requires three groups (seeded automatically by the entrypoint /
`install.sh`):

| Group | Grants |
|-------|--------|
| `app_sso_admin` | full admin (users, groups, settings) |
| `app_sso_oauth_admin` | OAuth client management |
| `app_sso_invite` | invitation management |
| `app_sso_service_account` | not a permission — marks a `posixAccount` as a non-person service account (see *Service accounts* below) |

## TLS (LDAPS / StartTLS)

The bundled slapd generates a **self-signed cert** on first start (CN =
`LDAP_CERT_CN`, valid 10y, SAN = CN + `localhost` + `127.0.0.1`) and listens on:

- `ldaps:///` — **636**, TLS (the port to expose for direct-LDAP clients).
- `ldap:///` — **389**, plain + StartTLS (not mapped to the host by default).

The cert lives on the `ldap-certs` volume so it persists across container
recreation.

### Trusting the self-signed cert

Copy it out and add it to the client's CA store:

```bash
docker compose cp sso-manager:/etc/openldap/certs/ldap.crt ./ldap.crt
```

…or, for quick LAN use, set `TLS_REQCERT never` on the client (the theta42/proxy
sets `app_ldap__tlsOptions__rejectUnauthorized=false` for the same effect).

### Using your own cert

Replace the `ldap-certs` named volume with a bind mount containing your own
`ldap.crt` + `ldap.key`:

```yaml
volumes:
  - ./certs:/etc/openldap/certs   # must contain ldap.crt + ldap.key
```

The entrypoint leaves existing certs untouched (idempotent).

## Service accounts

There are two different kinds of "not a real person" account, and which one
you want depends on what's consuming it:

**LDAP bind-only** — for an app that just needs to bind LDAP to look users up
(its own "LDAP authentication" settings page, or the read-only account
`theta42/ldap-client` binds as). Not a `posixAccount` — no `uidNumber`, no
home directory, can't log into this UI. Create one from the
**Integrations → LDAP** tab's *Service Accounts* section (create, rotate
password, delete). theta-env's bootstrap creates `cn=ldapclient` this same
way automatically, and the proxy binds as it — don't reuse the admin DN for
this.

**Unix/POSIX** — for an account something actually *runs as* on a Linux
host: a media manager, a torrent client, a service like Emby — anything that
needs a real `uidNumber`/`gidNumber` to own files or that other accounts join
via a group for write access (e.g. a `stuff_manager` group granting write
rights to a media library). Create one from the **Users** page's "Add new
user" form with **This is a service account** checked — it skips the
birthday/Terms-of-Service fields a real person's account needs and asks for
just an account name. It's a normal `posixAccount`, just flagged (via
membership in the `app_sso_service_account` group) so it's visibly marked in
the Users list and excluded from "all users" notification broadcasts.

Either way: don't reuse the admin DN, and give it only the group memberships
it actually needs.

Example bind test (LDAP bind-only account):

```bash
ldapsearch -x -H ldaps://sso.example.com:636 \
  -D "cn=ldapclient,ou=people,dc=yourdomain,dc=com" -W \
  -b "ou=people,dc=yourdomain,dc=com" '(objectClass=posixAccount)' cn mail
```

## Connecting a 3rd-party app or container

Most self-hosted apps with an "LDAP authentication" settings page — Gitea,
Nextcloud, Grafana, Emby, Jenkins, etc. — or containers configured via
`LDAP_*` env vars, all ask for the same handful of values. These are the
`conf.ldap` values from [Configuration](configuration.html), applied to
*your* domain:

| Field the app asks for | Value |
|---|---|
| Host / URL | `ldaps://<your-sso-host>:636` (preferred), or `ldap://<host>:389` + StartTLS |
| Bind DN | a dedicated service account — e.g. `cn=ldapclient,ou=people,<base>` (see above) |
| Bind password | that service account's password |
| User search base | `ou=people,<base>` |
| User search filter | `(objectClass=posixAccount)` |
| Username attribute | `uid` |
| Email attribute | `mail` |
| Group search base | `ou=groups,<base>` |
| Group membership attribute | `memberOf` (on the user entry — populated by the `memberof` overlay) |
| TLS | required for 636 (LDAPS); if using the bundled self-signed cert, either trust it (see *TLS* above) or set the app's "don't verify cert" option for LAN-only use |

### Worked example: Gitea

Gitea's **Admin → Authentication Sources → Add Authentication Source** (type
LDAP, "Bind DN/Password") maps directly:

- Security Protocol: `LDAPS`
- Host / Port: your SSO host / `636`
- Bind DN: `cn=ldapclient,ou=people,dc=yourdomain,dc=com`
- Bind Password: the service account's password
- User Search Base: `ou=people,dc=yourdomain,dc=com`
- User Filter: `(&(objectClass=posixAccount)(uid=%s))`
- Username Attribute: `uid`
- E-mail Attribute: `mail`

Other apps with an LDAP settings UI follow the same shape — the field names
above are the constants; only the base DN and hostname change per deployment.

### Generic Docker container (`LDAP_*` env vars)

For images that take a flat env-var LDAP config (there's no single standard,
but most look like this):

```yaml
environment:
  LDAP_URL: ldaps://sso.example.com:636
  LDAP_BIND_DN: cn=ldapclient,ou=people,dc=yourdomain,dc=com
  LDAP_BIND_PASSWORD: <service-account-password>
  LDAP_USER_BASE: ou=people,dc=yourdomain,dc=com
  LDAP_USER_FILTER: (objectClass=posixAccount)
  LDAP_GROUP_BASE: ou=groups,dc=yourdomain,dc=com
```

Check the specific image's docs for its actual variable names — the values
you plug in are still the ones from the table above.

### Full Linux host auth (SSH, sudo, login) instead of a single app

If you want a *host* (not just one app) to authenticate logins, SSH keys, and
sudo against this LDAP directory — not just one application — that's a
different integration (SSSD + PAM + NSS, not a single bind). See
[theta42/ldap-client](https://github.com/theta42/ldap-client): a script that
configures SSSD on Ubuntu/Debian hosts against this directory, including
group-based access control and SSH public key retrieval from LDAP.

## Modules + overlays (external LDAP servers)

If you point the app at your own LDAP server instead of the bundled slapd, it
needs:

- **Modules:** `pw-sha2` (the app stores user passwords as `{SSHA512}`),
  `ppolicy`, `memberof`, `refint`.
- **Custom schema:** the `theta42Person` auxiliary objectClass with
  `dateOfBirth` — see `ops/ldap-setup.sh` for the LDIF.
- **Directory tree:** `ou=people`, `ou=groups`, `ou=policies` under the base DN,
  a default `pwdPolicy` at `cn=ppolicy,ou=policies,<base>`.
- **Required groups:** `app_sso_admin`, `app_sso_invite`, `app_sso_oauth_admin`.

`ops/ldap-setup.sh -p <admin-password>` configures all of the above
idempotently against a running slapd (auto-detects the database holding your
base DN, and verifies `pwdAccountLockedTime` is live — the attribute the app's
active/inactive toggle depends on).

## Backups and restore

`ops/backup.sh` automates this (LDAP + Redis + `./config/`, with retention)
for standalone deployments — see the *Backups and restore* section of
`DEPLOYMENT.md`. The manual LDAP-only steps below are what it does under the
hood, useful if you want just the directory without Redis/config.

**Backup** (while slapd is running):

```bash
docker compose exec sso-manager slapcat -f /etc/openldap/slapd.conf \
  -b "dc=yourdomain,dc=com" > ldap-backup-$(date +%F).ldif
```

Store the `.ldif` off the host — it contains every user's password hash.

**Restore** into a stopped directory. The SSO image uses a static `slapd.conf`
(slapd starts with `-f`, not cn=config `-F`), so restore uses `slapadd -f`:

```bash
docker compose stop sso-manager
docker compose run --rm --no-deps --entrypoint sh sso-manager -c \
  'rm -f /var/lib/ldap/* && slapadd -f /etc/openldap/slapd.conf -l /dev/stdin' \
  < ldap-backup-<date>.ldif
docker compose start sso-manager
```

Verify: `docker compose exec sso-manager ldapsearch -x -b "dc=yourdomain,dc=com"`.

Redis state (OAuth clients, tokens) and `./config/` secrets are backed up
separately — see the *Backups and restore* section of `DEPLOYMENT.md` for the
full (LDAP + Redis + secrets) runbook.

## Troubleshooting

### `503 OpenLDAP ppolicy overlay is not configured`

The ppolicy overlay isn't attached to the database holding your users, so the
active/inactive toggle can't set `pwdAccountLockedTime`:

```bash
sudo ./ops/ldap-setup.sh -p 'admin-password' -b dc=yourdomain,dc=com
```

### LDAP connection refused

```bash
docker compose exec sso-manager sh -c 'ldapsearch -x -H ldap://localhost:389 -b "" -s base'
systemctl status slapd   # bare metal
```

[← Back to Home](index.html)