# SSO manager

## API docs
[API docs](api.md)

## Server set up

The server requires:
* NodeJS 13.x
* LDAP server

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

```bash
ldapadd -Y EXTERNAL -H ldapi:/// << 'EOF'
dn: olcOverlay=ppolicy,olcDatabase={1}mdb,cn=config
objectClass: olcOverlayConfig
objectClass: olcPPolicyConfig
olcOverlay: ppolicy
olcPPolicyDefault: cn=ppolicy,ou=policies,dc=theta42,dc=com
olcPPolicyUseLockout: TRUE
olcPPolicyHashCleartext: FALSE
EOF
```

**3. Create the policies container and default policy:**

```bash
ldapadd -x -D "cn=admin,dc=theta42,dc=com" -W << 'EOF'
dn: ou=policies,dc=theta42,dc=com
objectClass: organizationalUnit
ou: policies

dn: cn=ppolicy,ou=policies,dc=theta42,dc=com
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
ldapmodify -x -D "cn=admin,dc=theta42,dc=com" -W << 'EOF'
dn: cn=testuser,ou=people,dc=theta42,dc=com
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
