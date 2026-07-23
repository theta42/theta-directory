#!/usr/bin/env bash
# seed-test-user.sh — Create the test user in LDAP for the test suite.
#
# The test suite (tests/setup.js) logs in as uid=test / password=MyTestPassword!2.
# This script creates that user in the LDAP directory along with its personal
# posixGroup, and adds it to the app_sso_admin group so admin-gated tests pass.
#
# Environment variables (from docker-compose.test.yml):
#   LDAP_HOST     — LDAP server hostname (default: ldap)
#   LDAP_PORT     — LDAP server port (default: 389)
#   BIND_DN       — LDAP admin bind DN (default: cn=admin,dc=test,dc=local)
#   BIND_PW       — LDAP admin password (default: secret)
#   BASE_DN       — LDAP base DN (default: dc=test,dc=local)

set -euo pipefail

LDAP_HOST="${LDAP_HOST:-ldap}"
LDAP_PORT="${LDAP_PORT:-389}"
BIND_DN="${BIND_DN:-cn=admin,dc=test,dc=local}"
BIND_PW="${BIND_PW:-secret}"
BASE_DN="${BASE_DN:-dc=test,dc=local}"

LDAP_URI="ldap://${LDAP_HOST}:${LDAP_PORT}"
USER_UID="test"
USER_PASSWORD="MyTestPassword!2"

info()  { echo "[INFO] $*"; }
error() { echo "[ERROR] $*" >&2; }

# ── Wait for LDAP to be reachable ────────────────────────────────────────────
info "Waiting for LDAP at ${LDAP_URI}..."
for i in $(seq 1 30); do
    if ldapsearch -x -H "$LDAP_URI" -b '' -s base '(objectClass=*)' >/dev/null 2>&1; then
        info "LDAP is reachable"
        break
    fi
    if [ "$i" -eq 30 ]; then
        error "LDAP not reachable after 30 attempts"
        exit 1
    fi
    sleep 1
done

# ── Check if the test user already exists ────────────────────────────────────
if ldapsearch -x -H "$LDAP_URI" -D "$BIND_DN" -w "$BIND_PW" \
    -b "cn=${USER_UID},ou=people,${BASE_DN}" -s base '(objectClass=*)' >/dev/null 2>&1; then
    info "Test user '${USER_UID}' already exists — skipping seed"
    exit 0
fi

# ── Generate the SSHA512 password hash ───────────────────────────────────────
# Inline the hash function to avoid requiring the full model chain (which
# tries to connect to Redis/LDAP during module loading and would hang).
info "Generating password hash..."
PASSWORD_HASH=$(node -e "
    const crypto = require('crypto');
    const salt = crypto.randomBytes(8);
    const hash = crypto.createHash('sha512').update('${USER_PASSWORD}').update(salt).digest();
    console.log('{SSHA512}' + Buffer.concat([hash, salt]).toString('base64'));
")

info "Password hash generated"

# ── Create a temporary LDIF file ─────────────────────────────────────────────
TMPFILE=$(mktemp /tmp/seed-test-user.XXXXXX)
trap 'rm -f "$TMPFILE"' EXIT

cat > "$TMPFILE" << LDIF
# Personal posixGroup for the test user
dn: cn=${USER_UID},ou=groups,${BASE_DN}
objectClass: posixGroup
objectClass: top
cn: ${USER_UID}
gidNumber: 1500
description: Personal group for test user

# Test user posixAccount
dn: cn=${USER_UID},ou=people,${BASE_DN}
objectClass: inetOrgPerson
objectClass: posixAccount
objectClass: top
objectClass: theta42Person
objectClass: ldapPublicKey
objectClass: sudoRole
cn: ${USER_UID}
sn: Test
uid: ${USER_UID}
uidNumber: 1500
gidNumber: 1500
homeDirectory: /home/${USER_UID}
loginShell: /bin/bash
mail: test@test.local
userPassword: ${PASSWORD_HASH}
description: Test user for automated test suite
sudoHost: ALL
sudoCommand: ALL
sudoUser: ${USER_UID}
LDIF

# ── Add the entries to LDAP ──────────────────────────────────────────────────
info "Creating test user '${USER_UID}' in LDAP..."
ldapadd -x -H "$LDAP_URI" -D "$BIND_DN" -w "$BIND_PW" -f "$TMPFILE" 2>/dev/null || true
if ldapsearch -x -H "$LDAP_URI" -D "$BIND_DN" -w "$BIND_PW" \
    -b "cn=${USER_UID},ou=people,${BASE_DN}" -s base '(objectClass=*)' >/dev/null 2>&1; then
    info "Test user '${USER_UID}' exists or was created"
else
    error "Failed to create test user '${USER_UID}'"
    exit 1
fi

# ── Add the test user to required SSO groups ─────────────────────────────────
info "Adding test user to SSO admin groups..."
for group in app_sso_admin app_sso_invite app_sso_oauth_admin; do
    ldapmodify -x -H "$LDAP_URI" -D "$BIND_DN" -w "$BIND_PW" << EOF 2>/dev/null || true
dn: cn=${group},ou=groups,${BASE_DN}
changetype: modify
add: member
member: cn=${USER_UID},ou=people,${BASE_DN}
EOF
done
info "Test user added to SSO admin groups"

# ── Create additional users needed by tests ─────────────────────────────────
# wmantly is referenced by OTP (otp.test.js) and impersonation (impersonate.test.js)
# tests as an existing non-admin user.
WMANTLY_UID="wmantly"
if ! ldapsearch -x -H "$LDAP_URI" -D "$BIND_DN" -w "$BIND_PW" \
    -b "cn=${WMANTLY_UID},ou=people,${BASE_DN}" -s base '(objectClass=*)' >/dev/null 2>&1; then

    info "Creating additional test user '${WMANTLY_UID}'..."

    # Generate password hash for wmantly
    WMANTLY_HASH=$(node -e "
        const crypto = require('crypto');
        const salt = crypto.randomBytes(8);
        const hash = crypto.createHash('sha512').update('testpass').update(salt).digest();
        console.log('{SSHA512}' + Buffer.concat([hash, salt]).toString('base64'));
    ")

    cat > "$TMPFILE" << LDIF
dn: cn=${WMANTLY_UID},ou=groups,${BASE_DN}
objectClass: posixGroup
objectClass: top
cn: ${WMANTLY_UID}
gidNumber: 1501

dn: cn=${WMANTLY_UID},ou=people,${BASE_DN}
objectClass: inetOrgPerson
objectClass: posixAccount
objectClass: top
objectClass: theta42Person
objectClass: ldapPublicKey
objectClass: sudoRole
cn: ${WMANTLY_UID}
sn: Mantly
uid: ${WMANTLY_UID}
uidNumber: 1501
gidNumber: 1501
homeDirectory: /home/${WMANTLY_UID}
loginShell: /bin/bash
mail: wmantly@test.local
userPassword: ${WMANTLY_HASH}
sudoHost: ALL
sudoCommand: ALL
sudoUser: ${WMANTLY_UID}
LDIF
    ldapadd -x -H "$LDAP_URI" -D "$BIND_DN" -w "$BIND_PW" -f "$TMPFILE" 2>/dev/null || true
    if ldapsearch -x -H "$LDAP_URI" -D "$BIND_DN" -w "$BIND_PW" \
        -b "cn=${WMANTLY_UID},ou=people,${BASE_DN}" -s base '(objectClass=*)' >/dev/null 2>&1; then
        info "Additional test user '${WMANTLY_UID}' exists or was created"
    else
        error "Failed to create additional test user '${WMANTLY_UID}'"
        exit 1
    fi
fi

info "Seed complete — all test users are ready"
