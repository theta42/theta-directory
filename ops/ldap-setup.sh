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
# NOTE: ldapsearch echoes the search filter/base back as "# ..." comment lines.
# Those comments contain the very terms we grep for (e.g. "ppolicy"), which would
# make every existence check a false positive. Strip all comment lines so callers
# only ever see real result data.
config_search() {
    ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b "cn=config" "$@" 2>/dev/null | grep -v '^#'
}

# Run an ldapsearch against the directory (bind DN + password)
dir_search() {
    ldapsearch -x -D "$BIND_DN" -w "$ADMIN_PASS" -H ldapi:/// -b "$BASE_DN" "$@" 2>/dev/null | grep -v '^#'
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
warn() { echo "  [!!]  $*" >&2; }

# ── Detect the database that serves BASE_DN ──────────────────────────────────
# The ppolicy overlay MUST be attached to the database that actually holds the
# user entries, otherwise pwdAccountLockedTime is never registered for them and
# the app's active/inactive toggle fails with "undefined attribute type".
# Do NOT hardcode olcDatabase={1}mdb — the index/backend varies per install.
info "locating user database for ${BASE_DN}"

DB_DN=$(config_search -b "cn=config" \
    "(&(objectClass=olcDatabaseConfig)(olcSuffix=${BASE_DN}))" dn \
    | awk '/^dn:/{sub(/^dn: /,""); print; exit}')

if [[ -z "$DB_DN" ]]; then
    warn "Could not find a database with olcSuffix=${BASE_DN} under cn=config."
    warn "Check the base DN (-b) and that slapd is running with a cn=config backend."
    exit 1
fi
ok "user database: ${DB_DN}"

# ── 1. pw-sha2 module (SSHA512 password hashing) ─────────────────────────────
info "pw-sha2 module"

if config_search -b "cn=config" "(objectClass=olcModuleList)" olcModuleLoad | grep -q "^olcModuleLoad:.*pw-sha2"; then
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

if config_search -b "cn=config" "(objectClass=olcModuleList)" olcModuleLoad | grep -q "^olcModuleLoad:.*ppolicy"; then
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

if config_search -b "$DB_DN" "(olcOverlay=*ppolicy*)" dn | grep -qi "^dn:.*ppolicy"; then
    skip "ppolicy overlay already configured on ${DB_DN}"
else
    config_add "dn: olcOverlay=ppolicy,${DB_DN}
objectClass: olcOverlayConfig
objectClass: olcPPolicyConfig
olcOverlay: ppolicy
olcPPolicyDefault: cn=ppolicy,${POLICY_BASE}
olcPPolicyUseLockout: TRUE
olcPPolicyHashCleartext: FALSE"
    ok "ppolicy overlay added to ${DB_DN}"
fi

# ── 4. ppolicy schema ─────────────────────────────────────────────────────────
# The pwdPolicy objectClass and pwdAccountLockedTime attribute must be known to
# the RUNNING slapd (this is what User.setActive relies on).
#
# On OpenLDAP 2.5+ the ppolicy schema is BUILT INTO ppolicy.so and registered
# in memory when the module loads — it does NOT appear in cn=schema,cn=config,
# so we must check the live subschema (cn=Subschema) instead.
# On older builds the schema ships as a separate ppolicy.ldif that we load.
info "ppolicy schema"

# True if pwdPolicy is known to the running server right now.
ppolicy_schema_live() {
    ldapsearch -Q -Y EXTERNAL -H ldapi:/// -s base -b "cn=Subschema" \
        objectClasses attributeTypes 2>/dev/null | grep -qi "pwdPolicy"
}

if ppolicy_schema_live; then
    skip "ppolicy schema present in running slapd"
else
    # Try a shipped schema file (older OpenLDAP that doesn't build it into the module).
    PPOLICY_LDIF=""
    for candidate in \
        /etc/ldap/schema/ppolicy.ldif \
        /etc/openldap/schema/ppolicy.ldif \
        /usr/share/doc/slapd/examples/schema/ppolicy.ldif \
        /usr/local/etc/openldap/schema/ppolicy.ldif \
        /usr/share/ldap/schema/ppolicy.ldif; do
        [[ -f "$candidate" ]] && { PPOLICY_LDIF="$candidate"; break; }
    done

    if [[ -n "$PPOLICY_LDIF" ]]; then
        ldapadd -Q -Y EXTERNAL -H ldapi:/// -f "$PPOLICY_LDIF"
        ok "ppolicy schema loaded from $PPOLICY_LDIF"
    else
        # No schema file and not live: the module is meant to provide it built-in
        # but the running slapd hasn't registered it. This almost always means the
        # module was added to cn=config but slapd was never restarted to load it.
        warn "ppolicy schema is NOT registered in the running slapd and no ppolicy.ldif"
        warn "was found on disk. On OpenLDAP 2.5+ the schema is built into ppolicy.so"
        warn "and is registered on module load. Restart slapd and re-run this script:"
        warn "    systemctl restart slapd && $0 -p '<admin-password>'"
        exit 1
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

# ── 9. Verify ppolicy is actually active on the user database ─────────────────
# This is the exact condition the app relies on: if the ppolicy overlay is not
# attached to the database holding the users, modifying pwdAccountLockedTime
# fails and User.setActive() returns a 503.
info "verifying ppolicy is active on ${DB_DN}"

VERIFY_FAILED=0

if config_search -b "$DB_DN" "(olcOverlay=*ppolicy*)" dn | grep -qi "^dn:.*ppolicy"; then
    ok "ppolicy overlay is attached to the user database"
else
    warn "ppolicy overlay is NOT attached to ${DB_DN} — active/inactive toggle will fail"
    VERIFY_FAILED=1
fi

# The authoritative test: is pwdAccountLockedTime known to the running slapd?
# This is the exact attribute User.setActive modifies.
if ldapsearch -Q -Y EXTERNAL -H ldapi:/// -s base -b "cn=Subschema" attributeTypes 2>/dev/null \
    | grep -qi "pwdAccountLockedTime"; then
    ok "pwdAccountLockedTime attribute is registered (setActive will work)"
else
    warn "pwdAccountLockedTime is NOT registered — setActive will return 503"
    VERIFY_FAILED=1
fi

if dir_search -b "cn=ppolicy,${POLICY_BASE}" -s base "(objectClass=*)" dn 2>/dev/null | grep -q "dn:"; then
    ok "default password policy entry exists"
else
    warn "default ppolicy entry missing at cn=ppolicy,${POLICY_BASE}"
    VERIFY_FAILED=1
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo
if [[ "$VERIFY_FAILED" -eq 0 ]]; then
    echo "Setup complete. ppolicy is active — user active/inactive toggle will work."
else
    echo "Setup finished WITH WARNINGS — see [!!] lines above. The app's" >&2
    echo "active/inactive feature will not work until they are resolved." >&2
    exit 1
fi
