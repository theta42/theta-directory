# SSO manager

## API docs
[API docs](API.md)

## Server set up

### Recommended: Docker or install.sh

The supported, tested deployment paths are **Docker** (an all-in-one image
bundling the app + OpenLDAP + Redis) and the **`install.sh`** bare-metal
installer for Debian/Ubuntu. Most users should start there:

- [Deployment Guide](DEPLOYMENT.md) — Docker + bare metal, configuration
  layers, backups, troubleshooting.
- [docs/index.md](docs/index.md) — documentation home (also published as a
  GitHub Pages site), with links to configuration, LDAP, and OAuth/OIDC docs.

### Manual / advanced: raw OpenLDAP setup

The rest of this section walks through configuring OpenLDAP by hand. This is
the **manual/advanced path** — useful if you're pointing the app at an
existing LDAP server, or want to understand exactly what `install.sh` and the
Docker entrypoint automate for you. Most deployments should use Docker or
`install.sh` above instead.

The server requires:
* NodeJS 20.x
* LDAP server

> Setting up the whole stack (Docker) or want the secrets-file layout? See
> [DEPLOYMENT.md](DEPLOYMENT.md) — your domain is entered **once**, as the LDAP
> base DN (`stack.ldapBaseDn`); the LDAP DNs (`bindDN`/`userBase`/`groupBase`)
> and `oauth.issuer` all derive from it and must stay consistent. Running the
> unified `theta-env` stack, `setup.sh` fills those in for you from `setup.env`.

### OpenLDAP configuration

#### Password hashing (required)

Passwords are stored using `{SSHA512}` (salted SHA-512). The `pw-sha2` module must be loaded in slapd before creating or resetting any passwords.

```bash
ldapadd -Y EXTERNAL -H ldapi:/// << 'EOF'
dn: cn=module{0},cn=config
changetype: modify
add: olcModuleLoad
olcModuleLoad: pw-sha2
EOF
```

Verify the module is working:

```bash
slappasswd -h {SSHA512} -s testpassword
```

Existing `{MD5}` password hashes continue to work after the module is loaded — users are migrated to SSHA512 the next time they change their password.

#### Account locking (required for active/inactive toggle)

User activation and deactivation uses the OpenLDAP `ppolicy` overlay. When a user is marked inactive, `pwdAccountLockedTime` is set on their entry, which causes all LDAP binds to fail — including logins to Emby, Gitea, and any other LDAP-backed service.

> **The easy way:** run [`ops/ldap-setup.sh`](ops/ldap-setup.sh) on the LDAP server. It is idempotent, auto-detects the correct user database, applies everything below (pw-sha2, ppolicy module/overlay/schema, custom schema, policy entry, SSO groups) and verifies ppolicy is active at the end:
>
> ```bash
> sudo ./ops/ldap-setup.sh -p <admin-password>
> ```
>
> If the app returns `503 OpenLDAP ppolicy overlay is not configured` on `PUT /api/user/<uid>/active`, run this script — it means the overlay is not attached to the database holding your users. The manual steps below are equivalent and kept for reference.

**1. Load the ppolicy module:**

```bash
ldapadd -Y EXTERNAL -H ldapi:/// << 'EOF'
dn: cn=module{0},cn=config
changetype: modify
add: olcModuleLoad
olcModuleLoad: ppolicy
EOF
```

**2. Add the overlay to your user database:**

> Warning: The database index below (`{1}mdb`) is **not** the same on every install. Confirm yours first — the overlay must go on the database whose `olcSuffix` is your base DN, or account locking silently won't apply to your users:
>
> ```bash
> ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b cn=config \
>   '(&(objectClass=olcDatabaseConfig)(olcSuffix=dc=example,dc=com))' dn
> ```

```bash
ldapadd -Y EXTERNAL -H ldapi:/// << 'EOF'
dn: olcOverlay=ppolicy,olcDatabase={1}mdb,cn=config
objectClass: olcOverlayConfig
objectClass: olcPPolicyConfig
olcOverlay: ppolicy
olcPPolicyDefault: cn=ppolicy,ou=policies,dc=example,dc=com
olcPPolicyUseLockout: TRUE
olcPPolicyHashCleartext: FALSE
EOF
```

**3. Create the policies container and default policy:**

```bash
ldapadd -x -D "cn=admin,dc=example,dc=com" -W << 'EOF'
dn: ou=policies,dc=example,dc=com
objectClass: organizationalUnit
ou: policies

dn: cn=ppolicy,ou=policies,dc=example,dc=com
objectClass: top
objectClass: organizationalRole
objectClass: pwdPolicy
cn: ppolicy
pwdAttribute: 2.5.4.35
pwdLockout: FALSE
pwdMustChange: FALSE
pwdAllowUserChange: TRUE
EOF
```

Verify by locking a test account and confirming bind fails:

```bash
ldapmodify -x -D "cn=admin,dc=example,dc=com" -W << 'EOF'
dn: cn=testuser,ou=people,dc=example,dc=com
changetype: modify
replace: pwdAccountLockedTime
pwdAccountLockedTime: 000001010000Z
EOF
```

#### Custom schema (required for date of birth)

User accounts store a `dateOfBirth` field (ISO 8601 `YYYY-MM-DD`) for age verification. This requires a custom attribute type and auxiliary objectClass to be loaded into the OpenLDAP schema before any accounts are created.

**Load the schema:**

```bash
ldapadd -Y EXTERNAL -H ldapi:/// << 'EOF'
dn: cn=theta42,cn=schema,cn=config
objectClass: olcSchemaConfig
cn: theta42
olcAttributeTypes: ( 1.3.6.1.4.1.99999.1.1
  NAME 'dateOfBirth'
  DESC 'Date of birth in ISO 8601 format YYYY-MM-DD'
  EQUALITY caseExactMatch
  SUBSTR caseExactSubstringsMatch
  SYNTAX 1.3.6.1.4.1.1466.115.121.1.15
  SINGLE-VALUE )
olcObjectClasses: ( 1.3.6.1.4.1.99999.2.1
  NAME 'theta42Person'
  DESC 'Theta42 SSO extended person attributes'
  AUXILIARY
  MAY ( dateOfBirth ) )
EOF
```

Verify the schema loaded:

```bash
ldapsearch -Y EXTERNAL -H ldapi:/// -b "cn=theta42,cn=schema,cn=config" olcAttributeTypes olcObjectClasses
```

> **Note:** The OID prefix `1.3.6.1.4.1.99999` is used for internal/private schemas. If this deployment is ever connected to a federated directory, register a proper PEN at https://www.iana.org/assignments/enterprise-numbers and update the OIDs.

#### Required LDAP groups

| Group | Purpose |
|-------|---------|
| `app_sso_admin` | Full admin access: manage users, groups, OAuth clients |
| `app_sso_oauth_admin` | Manage OAuth clients only |
| `app_sso_invite` | Invitation management |

## Logs (Docker)

The all-in-one image runs the Node app and slapd (OpenLDAP) in one container,
both writing to the container's stdout/stderr, so `docker compose logs` is the
primary view (slapd runs with `-d 0`, so LDAP output is there too).

```bash
docker compose logs -f sso-manager          # app + slapd (stdout/stderr)
# or, by container name:
docker logs -f sso-manager

docker compose logs --tail=200 --since=10m sso-manager   # recent context

# Query the directory directly to confirm LDAP is healthy
docker compose exec sso-manager ldapsearch -x -H ldap://localhost:389 \
  -D "cn=admin,$LDAP_BASE_DN" -W -b "$LDAP_BASE_DN"
```

See [DEPLOYMENT.md](DEPLOYMENT.md) → *Troubleshooting* for LDAP-specific errors.
