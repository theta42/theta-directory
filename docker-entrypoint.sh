#!/usr/bin/env bash
# docker-entrypoint.sh — initialize the bundled OpenLDAP and start SSO Manager.
# Used by Dockerfile.openldap (the all-in-one image: app + slapd in one container).
#
# This is intended for development/testing / single-node deployments. For
# production, run a dedicated LDAP server and point the app at it via app_*
# env vars (or a mounted conf/secrets.js) using the app-only image.
#
# The app reads its configuration from conf/base.js + a secrets file, deep-merged
# by @simpleworkjs/conf (requires >= 1.2.0, pinned in nodejs/package-lock.json),
# with `app_*` environment variables as the highest-precedence override layer.
# This entrypoint exports those `app_*` vars so the app connects to the bundled
# slapd without any mounted secrets file. Any `app_*` var already set in the
# environment wins (the values below are defaults/fallbacks only).

set -e

# ── LDAP server-side configuration ──────────────────────────────────────────
LDAP_BASE_DN="${LDAP_BASE_DN:-dc=example,dc=com}"
LDAP_ADMIN_PASS="${LDAP_ADMIN_PASS:-admin}"
# Derive the DNS domain from the base DN (dc=foo,dc=bar -> foo.bar) unless given.
if [[ -z "${LDAP_DOMAIN:-}" ]]; then
    LDAP_DOMAIN=$(echo "$LDAP_BASE_DN" | sed 's/^dc=//; s/,dc=/./g')
fi
ORG_NAME="${ORG_NAME:-SSO Manager}"
LDAP_BIND_DN="${LDAP_BIND_DN:-cn=admin,${LDAP_BASE_DN}}"
# The app (inside the container) talks to the local slapd over localhost.
APP_LDAP_URL="${app_ldap__url:-ldap://localhost:389}"

info()  { echo "[INFO] $*"; }
error() { echo "[ERROR] $*" >&2; }

# ── Optional: load operational config from a mounted secrets.js ──────────────
# The unified theta-env stack mounts ./config/sso-secrets.js at /config and
# treats it as the authoritative source for the SSO's config (LDAP base, admin
# password, org name, JWT secret, ...). When present, point CONF_SECRETS at it
# so @simpleworkjs/conf reads it directly (no write access to /app/conf
# needed), and override the env-derived operational vars below with the
# file's values. When absent (standalone / env-var deployments) the env vars
# set above stay in effect and the app_* exports further down are emitted as
# before.
SECRETS_JS_MODE=0
if [[ -f /config/sso-secrets.js ]]; then
    export CONF_SECRETS=/config/sso-secrets.js
    SECRETS_JS_MODE=1
    # Pull the entrypoint's operational vars out of secrets.js in one node call.
    # Node emits `KEY<TAB>base64(value)` lines; we decode each with base64 -d and
    # assign via printf -v. base64 carries quotes / special chars safely with no
    # eval and no shell-quoting gymnastics. No app_* env is exported in this mode
    # — @simpleworkjs/conf reads the file directly, and any app_* env would
    # override it (precedence: base.js < <env>.js < secrets.js < app_* env).
    _node_out="$(node -e '
        const c = require("/config/sso-secrets.js");
        const b = s => Buffer.from(String(s == null ? "" : s)).toString("base64");
        const o = {
            LDAP_BASE_DN:    (c.stack && c.stack.ldapBaseDn) || "",
            LDAP_ADMIN_PASS: (c.ldap && c.ldap.bindPassword) || "",
            ORG_NAME:        c.name || "",
            LDAP_DOMAIN:     (c.stack && c.stack.ldapDomain) || "",
            LDAP_CERT_CN:    (c.stack && c.stack.ldapCertCn) || "",
            JWT_SECRET:      (c.oauth && c.oauth.jwtSecret) || "",
        };
        for (const k in o) console.log(k + "\t" + b(o[k]));
    ')" || { error "Failed to parse /config/sso-secrets.js (see stderr above)"; exit 1; }
    [[ -n "$_node_out" ]] || { error "/config/sso-secrets.js produced no config"; exit 1; }
    while IFS=$'\t' read -r _k _v; do
        [[ -n "$_k" ]] || continue
        printf -v "$_k" '%s' "$(printf '%s' "$_v" | base64 -d)"
    done <<< "$_node_out"
    LDAP_BIND_DN="cn=admin,${LDAP_BASE_DN}"
    [[ -n "$LDAP_ADMIN_PASS" ]] || { error "/config/sso-secrets.js: ldap.bindPassword is empty"; exit 1; }
    [[ -n "$JWT_SECRET"      ]] || { error "/config/sso-secrets.js: oauth.jwtSecret is empty"; exit 1; }
    info "Loaded config from /config/sso-secrets.js (secrets.js authoritative)"
fi

# ── Locate the OpenLDAP module directory ────────────────────────────────────
# slapd.conf needs `modulepath` to find pw-sha2/ppolicy/memberof/refint. The
# path varies by distro; auto-detect rather than hardcode.
MODULE_PATH=""
for p in /usr/lib/openldap /usr/lib/ldap /usr/local/lib/openldap /opt/local/lib/openldap; do
    if [[ -d "$p" ]]; then MODULE_PATH="$p"; break; fi
done

# ── TLS certificate for LDAPS / StartTLS ────────────────────────────────────
# Legacy apps (e.g. the theta42/proxy, Gitea, Emby) bind to LDAP directly over the
# network. To keep password binds off the wire in cleartext we expose LDAPS
# (636) and allow StartTLS on 389. By default a self-signed cert is generated on
# first start; mount your own cert+key at LDAP_CERT_DIR to use a CA-signed cert
# instead (idempotent: existing certs are never overwritten).
LDAP_CERT_DIR="${LDAP_CERT_DIR:-/etc/openldap/certs}"
# CN/SAN hostname clients will verify against. Default to the DNS domain derived
# from the base DN (dc=foo,dc=bar -> foo.bar); override for a public hostname.
LDAP_CERT_CN="${LDAP_CERT_CN:-${LDAP_DOMAIN:-localhost}}"
mkdir -p "$LDAP_CERT_DIR"
if [[ -f "$LDAP_CERT_DIR/ldap.crt" && -f "$LDAP_CERT_DIR/ldap.key" ]]; then
    info "Using existing LDAP TLS cert at $LDAP_CERT_DIR (mounted or previously generated)"
else
    info "Generating self-signed LDAP TLS cert (CN=$LDAP_CERT_CN, valid 10y)..."
    openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout "$LDAP_CERT_DIR/ldap.key" -out "$LDAP_CERT_DIR/ldap.crt" \
        -days 3650 -subj "/CN=$LDAP_CERT_CN" \
        -addext "subjectAltName=DNS:$LDAP_CERT_CN,DNS:localhost,IP:127.0.0.1" \
        >/dev/null 2>&1 || {
            error "Failed to generate LDAP TLS cert"
            exit 1
        }
fi
# slapd runs as the ldap user and must read both cert and key.
chown -R ldap:ldap "$LDAP_CERT_DIR" 2>/dev/null || true
chmod 600 "$LDAP_CERT_DIR/ldap.key" 2>/dev/null || true
chmod 644 "$LDAP_CERT_DIR/ldap.crt" 2>/dev/null || true

# ── Generate slapd.conf ─────────────────────────────────────────────────────
# We use slapd.conf (static config) rather than cn=config so the whole directory
# is configured from a single generated file. slapd is started with -f below so
# it actually reads this file (the original entrypoint omitted -f, so slapd
# ignored it entirely).

cat > /etc/openldap/slapd.conf << SLAPDEOF
include         /etc/openldap/schema/core.schema
include         /etc/openldap/schema/cosine.schema
include         /etc/openldap/schema/inetorgperson.schema
include         /etc/openldap/schema/nis.schema
include         /etc/openldap/schema/theta42.schema
include         /etc/openldap/schema/sudo.schema
include         /etc/openldap/schema/openssh-lpk.schema

SERVER_ID_PLACEHOLDER

# Module loading (pw-sha2 provides {SSHA512} used by the app for user passwords;
# ppolicy/memberof/refint are the overlays the app depends on). On OpenLDAP 2.5+
# the ppolicy schema (pwdPolicy, pwdAccountLockedTime, ...) is built into
# ppolicy.so and registered when the module loads — there is no separate
# ppolicy.schema to include, and loading the module before the overlay below
# is what makes the pwdPolicy objectClass known to slapd.
SLAPMODULEPATH
moduleload      back_mdb
moduleload      pw-sha2
moduleload      ppolicy
moduleload      memberof
moduleload      refint
moduleload      auditlog
SYNCPROV_MODULE_PLACEHOLDER

# TLS (LDAPS on 636 + StartTLS on 389). Cert/key paths are fixed; the files are
# generated/mounted above. We accept clients without their own cert (the common
# case for LDAP bind clients) and treat our own self-signed cert as the CA.
TLSCertificateFile      /etc/openldap/certs/ldap.crt
TLSCertificateKeyFile   /etc/openldap/certs/ldap.key
TLSCACertificateFile    /etc/openldap/certs/ldap.crt
TLSVerifyClient         never

# Database configuration
database        mdb
# Store the mdb files on the persistent volume (docker-compose mounts a named
# volume at /var/lib/ldap). Without this, mdb defaults to
# /var/lib/openldap/openldap-data and the directory would be lost on recreation.
directory       /var/lib/ldap
suffix          SUFFIX_PLACEHOLDER
rootdn          BIND_DN_PLACEHOLDER
# rootpw uses {SSHA} (built into slapd, no module needed) so slappasswd never
# depends on a loadable module to generate or verify it. User passwords are
# stored as {SSHA512} by the app itself and verified via the pw-sha2 module.
rootpw          ROOTPW_PLACEHOLDER

# Indexes
index           objectClass     eq
index           uid             eq,sub
index           mail            eq,sub
index           cn              eq,sub
index            member          eq
index           uidNumber       eq
index           gidNumber       eq

# ppolicy overlay (account locking — the app's active/inactive toggle relies on
# pwdAccountLockedTime being a known attribute).
overlay         ppolicy
ppolicy_default "cn=ppolicy,ou=policies,SUFFIX_PLACEHOLDER"
ppolicy_use_lockout true

# memberof overlay (reverse group membership)
overlay         memberof
memberof-group-oc groupOfNames
memberof-member-ad member
memberof-memberof-ad memberOf

# refint overlay (referential integrity on group membership)
overlay         refint
refint_attributes memberOf member manager owner

# auditlog overlay (LDIF audit trail of all changes)
overlay         auditlog
auditlog        /var/lib/ldap/auditlog.ldif

REPLICATION_BLOCK_PLACEHOLDER

# Access controls
access to attrs=userPassword
    by dn="BIND_DN_PLACEHOLDER" write
    by anonymous auth
    by self write
    by * none

access to *
    by dn="BIND_DN_PLACEHOLDER" write
    by * read
SLAPDEOF

# Generate the rootpw hash ({SSHA}, built-in — no module dependency).
HASHED_PASS=$(slappasswd -s "$LDAP_ADMIN_PASS")

# Fill placeholders.
DC_VALUE="${LDAP_BASE_DN%%,*}"          # dc=example
DC_VALUE="${DC_VALUE#dc=}"              # example
sed -i "s|SUFFIX_PLACEHOLDER|${LDAP_BASE_DN}|g"        /etc/openldap/slapd.conf
sed -i "s|BIND_DN_PLACEHOLDER|${LDAP_BIND_DN}|g"        /etc/openldap/slapd.conf
sed -i "s|ROOTPW_PLACEHOLDER|${HASHED_PASS}|g"         /etc/openldap/slapd.conf
if [[ -n "$MODULE_PATH" ]]; then
    sed -i "s|^SLAPMODULEPATH$|modulepath      ${MODULE_PATH}|" /etc/openldap/slapd.conf
else
    sed -i "/^SLAPMODULEPATH$/d" /etc/openldap/slapd.conf
fi

# ── Multi-Master Replication Configuration ──
if [[ -n "${LDAP_SERVER_ID:-}" && -n "${LDAP_REPLICATION_HOSTS:-}" ]]; then
    info "Configuring Multi-Master replication (Server ID: ${LDAP_SERVER_ID})"
    sed -i "s|^SERVER_ID_PLACEHOLDER|ServerID ${LDAP_SERVER_ID}|" /etc/openldap/slapd.conf
    sed -i "s|^SYNCPROV_MODULE_PLACEHOLDER|moduleload      syncprov|" /etc/openldap/slapd.conf
    
    # Generate syncrepl blocks
    REPL_BLOCK="overlay syncprov\nsyncprov-checkpoint 100 10\nsyncprov-sessionlog 100\n\n"
    RID=100
    for HOST in ${LDAP_REPLICATION_HOSTS}; do
        RID=$((RID + 1))
        REPL_BLOCK="${REPL_BLOCK}syncrepl rid=${RID}\n  provider=${HOST}\n  type=refreshAndPersist\n  retry=\"60 +\"\n  searchbase=\"${LDAP_BASE_DN}\"\n  bindmethod=simple\n  binddn=\"${LDAP_BIND_DN}\"\n  credentials=\"${LDAP_ADMIN_PASS}\"\n\n"
    done
    REPL_BLOCK="${REPL_BLOCK}mirrormode on\n"
    
    # Replace placeholder (awk is safer for multiline replacements than sed)
    awk -v repl="$(printf '%b' "$REPL_BLOCK")" '{gsub(/REPLICATION_BLOCK_PLACEHOLDER/, repl)}1' /etc/openldap/slapd.conf > /etc/openldap/slapd.conf.tmp
    mv /etc/openldap/slapd.conf.tmp /etc/openldap/slapd.conf
else
    sed -i "/^SERVER_ID_PLACEHOLDER/d" /etc/openldap/slapd.conf
    sed -i "/^SYNCPROV_MODULE_PLACEHOLDER/d" /etc/openldap/slapd.conf
    sed -i "/^REPLICATION_BLOCK_PLACEHOLDER/d" /etc/openldap/slapd.conf
fi

chown ldap:ldap /etc/openldap/slapd.conf 2>/dev/null || true
chown -R ldap:ldap /var/lib/ldap 2>/dev/null || true

# ── Start slapd ─────────────────────────────────────────────────────────────
info "Starting OpenLDAP (base DN: ${LDAP_BASE_DN})..."
# -f forces slapd to use our generated slapd.conf (not cn=config).
# -h listens on ldap:///  (389: plain + StartTLS) and ldaps:/// (636: LDAPS).
# ldapi:/// is intentionally omitted: its default socket dir doesn't exist on
# Alpine and the container only uses simple bind over ldap://localhost:389.
slapd -d 256 -u ldap -g ldap -f /etc/openldap/slapd.conf -h "ldap:/// ldaps:///" >> /var/lib/ldap/slapd.log 2>&1 &
SLAPD_PID=$!

# Wait for slapd to answer the root DSE (means it's up, regardless of DB state).
for i in $(seq 1 30); do
    if ldapsearch -x -H ldap://localhost:389 -b "" -s base "(objectClass=*)" >/dev/null 2>&1; then
        info "OpenLDAP is ready"
        break
    fi
    info "Waiting for OpenLDAP... ($i/30)"
    sleep 1
done

if ! kill -0 "$SLAPD_PID" 2>/dev/null; then
    error "OpenLDAP failed to start"
    exit 1
fi

# ── Initialize the directory tree (idempotent) ──────────────────────────────
# Only seed if the base DN doesn't exist yet, so restarting the container is safe.
if ! ldapsearch -x -H ldap://localhost:389 -b "$LDAP_BASE_DN" -s base "(objectClass=*)" >/dev/null 2>&1; then
    info "Initializing LDAP directory..."

    ldapadd -x -D "$LDAP_BIND_DN" -w "$LDAP_ADMIN_PASS" -H ldap://localhost:389 << EOF
dn: ${LDAP_BASE_DN}
objectClass: dcObject
objectClass: organization
dc: ${DC_VALUE}
o: ${ORG_NAME}

dn: ou=people,${LDAP_BASE_DN}
objectClass: organizationalUnit
ou: people

dn: ou=groups,${LDAP_BASE_DN}
objectClass: organizationalUnit
ou: groups

dn: ou=policies,${LDAP_BASE_DN}
objectClass: organizationalUnit
ou: policies

dn: cn=ppolicy,ou=policies,${LDAP_BASE_DN}
objectClass: top
objectClass: organizationalRole
objectClass: pwdPolicy
cn: ppolicy
pwdAttribute: 2.5.4.35
pwdLockout: TRUE
pwdMustChange: FALSE
pwdAllowUserChange: TRUE
EOF

    # Required SSO groups. The app gates admin/invite/oauth-admin on these;
    # app_sso_service_account is a marker (not a permission gate) for
    # non-person accounts -- see the Users page.
    for group in app_sso_admin app_sso_invite app_sso_oauth_admin app_sso_service_account; do
        ldapadd -x -D "$LDAP_BIND_DN" -w "$LDAP_ADMIN_PASS" -H ldap://localhost:389 << EOF || true
dn: cn=${group},ou=groups,${LDAP_BASE_DN}
objectClass: groupOfNames
objectClass: top
cn: ${group}
description: ${ORG_NAME} ${group} group
member: ${LDAP_BIND_DN}
EOF
    done

    info "LDAP directory initialized"
else
    info "LDAP directory already initialized — skipping seed"
fi

# ── Start Redis ──────────────────────────────────────────────────────────────
# The app stores models/sessions in Redis (model-redis), and the SSO's
# non-bootstrap OAuth clients also live there. The all-in-one image bundles a
# Redis server for a self-contained single-node deployment. Persist it to /data
# (AOF + RDB) so OAuth clients, tokens, and other Redis-backed state survive
# container recreation. Point the app at an external Redis instead by setting
# app_redis__host before starting (then no bundled Redis runs here). redis runs
# as root in this image, so a root-owned /data is writable.
if [[ -z "${app_redis__host:-}" ]]; then
    REDIS_DATA_DIR="${REDIS_DATA_DIR:-/data}"
    mkdir -p "$REDIS_DATA_DIR"
    chmod 700 "$REDIS_DATA_DIR"
    info "Starting Redis (AOF persisted to $REDIS_DATA_DIR)..."
    redis-server --daemonize no --dir "$REDIS_DATA_DIR" --appendonly yes \
        --appendfilename appendonly.aof --save 900 1 --save 300 10 --save 60 10000 \
        --dbfilename dump.rdb &
    REDIS_PID=$!
    for i in $(seq 1 15); do
        if redis-cli ping >/dev/null 2>&1; then
            info "Redis is ready"
            break
        fi
        sleep 0.5
    done
    if ! kill -0 "$REDIS_PID" 2>/dev/null; then
        error "Redis failed to start"
        exit 1
    fi
    # App defaults to 127.0.0.1:6379 (the redis client default), so no override
    # is needed when running the bundled Redis.
fi

# ── Generate a JWT secret if none was provided (env mode only) ──────────────
# In secrets.js mode the JWT secret comes from the file and was validated above.
if [[ "${SECRETS_JS_MODE:-0}" != 1 && -z "${JWT_SECRET:-}" && -z "${app_oauth__jwtSecret:-}" ]]; then
    if command -v openssl >/dev/null 2>&1; then
        JWT_SECRET=$(openssl rand -hex 32)
    else
        JWT_SECRET="$LDAP_ADMIN_PASS-jwt-secret-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' ')"
    fi
    info "Generated JWT secret (set JWT_SECRET or app_oauth__jwtSecret to persist)"
fi

# ── Export app_* config overrides for the SSO Manager process (env mode) ─────
# In secrets.js mode the app reads /app/conf/secrets.js directly, so we export
# NO app_* vars — they would override the file (@simpleworkjs/conf precedence:
# base.js < <env>.js < secrets.js < app_* env). In env mode these remain the
# highest-precedence layer, derived from the LDAP_* / ORG_NAME / SMTP_* env.
if [[ "${SECRETS_JS_MODE:-0}" != 1 ]]; then
    export app_ldap__url="${app_ldap__url:-$APP_LDAP_URL}"
    export app_ldap__bindDN="${app_ldap__bindDN:-$LDAP_BIND_DN}"
    export app_ldap__bindPassword="${app_ldap__bindPassword:-$LDAP_ADMIN_PASS}"
    export app_ldap__userBase="${app_ldap__userBase:-ou=people,${LDAP_BASE_DN}}"
    export app_ldap__groupBase="${app_ldap__groupBase:-ou=groups,${LDAP_BASE_DN}}"
    export app_oauth__jwtSecret="${app_oauth__jwtSecret:-$JWT_SECRET}"
    # OIDC issuer advertised in /.well-known/openid-configuration. Default to the
    # public https URL on the SSO subdomain of the LDAP domain; override with
    # OAUTH_ISSUER / app_oauth__issuer. Computed here (not in compose) because
    # compose v1 doesn't interpolate nested ${VAR:-...} defaults.
    export app_oauth__issuer="${app_oauth__issuer:-https://sso.${LDAP_DOMAIN}}"
    export app_name="${app_name:-$ORG_NAME}"

    # SMTP (optional). If no user/pass, disable auth by clearing the user.
    export app_smtp__host="${app_smtp__host:-${SMTP_HOST:-localhost}}"
    export app_smtp__port="${app_smtp__port:-${SMTP_PORT:-587}}"
    if [[ -n "${SMTP_USER:-}" || -n "${SMTP_PASS:-}" ]]; then
        export app_smtp__user="${app_smtp__user:-$SMTP_USER}"
        export app_smtp__pass="${app_smtp__pass:-$SMTP_PASS}"
    else
        export app_smtp__user="${app_smtp__user:-}"
    fi
fi

# HTTP port for the app (bin/www reads NODE_PORT).
export NODE_PORT="${NODE_PORT:-${PORT:-3001}}"
export NODE_ENV="${NODE_ENV:-production}"

info "Starting SSO Manager on port ${NODE_PORT}..."
exec "$@"