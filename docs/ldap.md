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

## Direct-bind service accounts

For apps that bind LDAP directly, create a dedicated **service account** under
`ou=people` (e.g. `cn=ldapclient,ou=people,<base>`) with a strong password —
**don't reuse the admin DN**. The theta-env bootstrap creates this account
automatically (`cn=ldapclient`) and the proxy binds as it.

Example bind test:

```bash
ldapsearch -x -H ldaps://sso.example.com:636 \
  -D "cn=ldapclient,ou=people,dc=yourdomain,dc=com" -W \
  -b "ou=people,dc=yourdomain,dc=com" '(objectClass=posixAccount)' cn mail
```

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