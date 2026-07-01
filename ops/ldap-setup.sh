#!/usr/bin/env bash
# ldap-setup.sh — Idempotent OpenLDAP configuration for Theta42 SSO
#
# Must be run on the LDAP server (or a host with access to the local ldapi socket).
# cn=config changes use SASL EXTERNAL (run as root). Directory changes use bind DN + password.
#
# Usage:
#   sudo ./ldap-setup.sh -p <admin-password>
#   sudo ./ldap-setup.sh -p <admin-password> -b dc=theta42,dc=com -D cn=admin,dc=theta42,dc=com
#
# Options:
#   -p PASSWORD   LDAP admin password (required)
#   -b BASE_DN    Base DN (default: dc=theta42,dc=com)
#   -D BIND_DN    Admin bind DN (default: cn=admin,<BASE_DN>)
#   -h            Show this help

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
BASE_DN="dc=theta42,dc=com"
BIND_DN=""
ADMIN_PASS=""

usage() {
    grep '^#' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

while getopts "p:b:D:h" opt; do
    case $opt in
        p) ADMIN_PASS="$OPTARG" ;;
        b) BASE_DN="$OPTARG" ;;
        D) BIND_DN="$OPTARG" ;;
        h) usage ;;
        *) echo "Unknown option: -$OPTARG" >&2; exit 1 ;;
    esac
done

if [[ -z "$ADMIN_PASS" ]]; then
    echo "Error: admin password is required (-p)" >&2
    exit 1
fi

[[ -z "$BIND_DN" ]] && BIND_DN="cn=admin,${BASE_DN}"

GROUP_BASE="ou=groups,${BASE_DN}"
POLICY_BASE="ou=policies,${BASE_DN}"

# ── Helpers ───────────────────────────────────────────────────────────────────

TMPFILE=$(mktemp /tmp/ldap-setup.XXXXXX.ldif)
trap 'rm -f "$TMPFILE"' EXIT

# Run an ldapsearch against cn=config (EXTERNAL/SASL — must be root)
config_search() {
    ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b "cn=config" "$@" 2>/dev/null
}

# Run an ldapsearch against the directory (bind DN + password)
dir_search() {
    ldapsearch -x -D "$BIND_DN" -w "$ADMIN_PASS" -H ldapi:/// -b "$BASE_DN" "$@" 2>/dev/null
}

# Apply an LDIF file via ldapadd against cn=config
config_add() {
    printf '%s\n' "$1" > "$TMPFILE"
    ldapadd -Q -Y EXTERNAL -H ldapi:/// -f "$TMPFILE"
}

# Apply an LDIF file via ldapadd against the directory
dir_add() {
    printf '%s\n' "$1" > "$TMPFILE"
    ldapadd -x -D "$BIND_DN" -w "$ADMIN_PASS" -H ldapi:/// -f "$TMPFILE"
}

ok()   { echo "  [ok]  $*"; }
skip() { echo "  [--]  $* (already applied)"; }
info() { echo; echo "==> $*"; }

# ── 1. pw-sha2 module (SSHA512 password hashing) ─────────────────────────────
info "pw-sha2 module"

if config_search -b "cn=module{0},cn=config" "(olcModuleLoad=pw-sha2)" | grep -q "pw-sha2"; then
    skip "pw-sha2 already loaded"
else
    config_add "dn: cn=module{0},cn=config
changetype: modify
add: olcModuleLoad
olcModuleLoad: pw-sha2"
    ok "pw-sha2 loaded"
fi

# ── 2. ppolicy module ─────────────────────────────────────────────────────────
info "ppolicy module"

if config_search -b "cn=module{0},cn=config" "(olcModuleLoad=ppolicy)" | grep -q "ppolicy"; then
    skip "ppolicy module already loaded"
else
    config_add "dn: cn=module{0},cn=config
changetype: modify
add: olcModuleLoad
olcModuleLoad: ppolicy"
    ok "ppolicy module loaded"
fi

# ── 3. ppolicy overlay ────────────────────────────────────────────────────────
info "ppolicy overlay"

if config_search -b "cn=config" "(olcOverlay=ppolicy)" | grep -q "ppolicy"; then
    skip "ppolicy overlay already configured"
else
    config_add "dn: olcOverlay=ppolicy,olcDatabase={1}mdb,cn=config
objectClass: olcOverlayConfig
objectClass: olcPPolicyConfig
olcOverlay: ppolicy
olcPPolicyDefault: cn=ppolicy,${POLICY_BASE}
olcPPolicyUseLockout: TRUE
olcPPolicyHashCleartext: FALSE"
    ok "ppolicy overlay added"
fi

# ── 4. ppolicy schema ─────────────────────────────────────────────────────────
# The ppolicy module registers its schema internally when loaded — loading a
# separate schema LDIF creates duplicate OIDs and breaks slapd. Only load from
# a .ldif file if a ppolicy.ldif is explicitly present on disk AND the module
# hasn't already registered the schema via its built-in definitions.
info "ppolicy schema"

if ldapsearch -Q -Y EXTERNAL -H ldapi:/// \
    -b "cn=schema,cn=config" -s sub \
    "(olcObjectClasses=*pwdPolicy*)" olcObjectClasses 2>/dev/null \
    | grep -q "^olcObjectClasses:"; then
    skip "ppolicy schema already loaded"
else
    PPOLICY_LDIF=""
    for candidate in \
        /etc/ldap/schema/ppolicy.ldif \
        /etc/openldap/schema/ppolicy.ldif \
        /usr/share/doc/slapd/examples/schema/ppolicy.ldif \
        /usr/local/etc/openldap/schema/ppolicy.ldif \
        /usr/share/ldap/schema/ppolicy.ldif; do
        if [[ -f "$candidate" ]]; then
            PPOLICY_LDIF="$candidate"
            break
        fi
    done

    if [[ -n "$PPOLICY_LDIF" ]]; then
        ldapadd -Q -Y EXTERNAL -H ldapi:/// -f "$PPOLICY_LDIF"
        ok "ppolicy schema loaded from $PPOLICY_LDIF"
    else
        echo "  [--]  ppolicy schema is registered internally by the module (no .ldif needed)"
    fi
fi

# ── 5. Custom theta42 schema (dateOfBirth) ────────────────────────────────────
info "theta42 custom schema"

if config_search -b "cn=schema,cn=config" "(olcObjectClasses=*theta42Person*)" olcObjectClasses | grep -q "^olcObjectClasses:"; then
    skip "theta42 schema already loaded"
else
    config_add "dn: cn=theta42,cn=schema,cn=config
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
  MAY ( dateOfBirth ) )"
    ok "theta42 schema loaded"
fi

# ── 6. Policies OU ────────────────────────────────────────────────────────────
info "policies container (${POLICY_BASE})"

if dir_search -b "$POLICY_BASE" -s base "(objectClass=*)" dn 2>/dev/null | grep -q "dn:"; then
    skip "${POLICY_BASE} already exists"
else
    dir_add "dn: ${POLICY_BASE}
objectClass: organizationalUnit
ou: policies"
    ok "${POLICY_BASE} created"
fi

# ── 7. Default ppolicy entry ──────────────────────────────────────────────────
info "default ppolicy entry"

if dir_search -b "cn=ppolicy,${POLICY_BASE}" -s base "(objectClass=*)" dn 2>/dev/null | grep -q "dn:"; then
    skip "cn=ppolicy,${POLICY_BASE} already exists"
else
    dir_add "dn: cn=ppolicy,${POLICY_BASE}
objectClass: top
objectClass: organizationalRole
objectClass: pwdPolicy
cn: ppolicy
pwdAttribute: 2.5.4.35
pwdLockout: FALSE
pwdMustChange: FALSE
pwdAllowUserChange: TRUE"
    ok "default ppolicy created"
fi

# ── 8. Required SSO groups ────────────────────────────────────────────────────
info "required SSO groups"

for group in app_sso_admin app_sso_invite app_sso_oauth_admin; do
    dn="cn=${group},${GROUP_BASE}"
    if dir_search -b "$dn" -s base "(objectClass=*)" dn 2>/dev/null | grep -q "dn:"; then
        skip "${dn} already exists"
    else
        dir_add "dn: ${dn}
objectClass: groupOfNames
objectClass: top
cn: ${group}
description: Theta42 SSO ${group} group
member: ${BIND_DN}"
        ok "${dn} created"
    fi
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo
echo "Setup complete."
