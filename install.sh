#!/usr/bin/env bash
# install.sh - Idempotent standalone installer for Theta42 SSO Manager
# For Debian/Ubuntu systems
#
# This script:
#   1. Installs Node.js 20.x
#   2. Installs and configures OpenLDAP with required schemas/overlays
#   3. Deploys the SSO Manager application
#   4. Sets up systemd services
#
# Usage:
#   sudo ./install.sh [OPTIONS]
#
# Options:
#   -p, --admin-pass PASSWORD    LDAP admin password (required, or set via LDAP_ADMIN_PASS env)
#   -b, --base-dn DN             Base DN (default: dc=example,dc=com)
#   -n, --org-name NAME          Organization name shown in UI/email (default: SSO Manager)
#   -o, --port PORT              HTTP port for SSO Manager (default: 3001)
#   -j, --jwt-secret SECRET      JWT secret for OAuth (default: auto-generated)
#   -s, --smtp-config CONFIG     SMTP config as host:port:user:pass
#   --skip-ldap                  Skip LDAP installation (use existing LDAP)
#   --skip-app                   Skip application installation (LDAP setup only)
#   --dry-run                    Show what would be done without making changes
#   -h, --help                   Show this help
#
# Environment variables (alternative to flags):
#   LDAP_ADMIN_PASS, LDAP_BASE_DN, PORT, JWT_SECRET, SMTP_*

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
BASE_DN="${LDAP_BASE_DN:-dc=example,dc=com}"
ADMIN_PASS="${LDAP_ADMIN_PASS:-}"
ORG_NAME="${ORG_NAME:-SSO Manager}"
PORT="${PORT:-3001}"
JWT_SECRET="${JWT_SECRET:-}"
SMTP_HOST="${SMTP_HOST:-}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASS="${SMTP_PASS:-}"
SKIP_LDAP="${SKIP_LDAP:-false}"
SKIP_APP="${SKIP_APP:-false}"
DRY_RUN="${DRY_RUN:-false}"

INSTALL_DIR="/opt/sso-manager"
SYSTEMD_DIR="/etc/systemd/system"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ── Helper functions ──────────────────────────────────────────────────────────
info() { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
dry_run() { if [[ "$DRY_RUN" == "true" ]]; then echo "[DRY-RUN] $*"; fi; }

usage() {
    grep '^#' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--admin-pass)
            ADMIN_PASS="$2"
            shift 2
            ;;
        -b|--base-dn)
            BASE_DN="$2"
            shift 2
            ;;
        -n|--org-name)
            ORG_NAME="$2"
            shift 2
            ;;
        -o|--port)
            PORT="$2"
            shift 2
            ;;
        -j|--jwt-secret)
            JWT_SECRET="$2"
            shift 2
            ;;
        -s|--smtp-config)
            IFS=':' read -r SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS <<< "$2"
            shift 2
            ;;
        --skip-ldap)
            SKIP_LDAP="true"
            shift
            ;;
        --skip-app)
            SKIP_APP="true"
            shift
            ;;
        --dry-run)
            DRY_RUN="true"
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            error "Unknown option: $1"
            usage
            ;;
    esac
done

# Validate required parameters
if [[ -z "$ADMIN_PASS" ]]; then
    error "LDAP admin password is required (-p or LDAP_ADMIN_PASS env)"
    exit 1
fi

# Generate JWT secret if not provided
if [[ -z "$JWT_SECRET" ]]; then
    JWT_SECRET=$(openssl rand -hex 32)
    info "Generated JWT secret: ${JWT_SECRET:0:8}..."
fi

# Derive the DNS domain from the base DN (dc=foo,dc=bar -> foo.bar) for email
# sender defaults. Override with LDAP_DOMAIN if set.
if [[ -z "${LDAP_DOMAIN:-}" ]]; then
    LDAP_DOMAIN=$(echo "$BASE_DN" | sed 's/^dc=//; s/,dc=/./g')
fi

# ── System checks ─────────────────────────────────────────────────────────────
check_root() {
    if [[ $EUID -ne 0 ]]; then
        error "This script must be run as root (sudo)"
        exit 1
    fi
}

check_os() {
    if [[ ! -f /etc/debian_version ]]; then
        error "This script is for Debian/Ubuntu systems only"
        exit 1
    fi
    info "Detected $(cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2)"
}

# ── Package installation ──────────────────────────────────────────────────────
install_package() {
    local pkg="$1"
    if dpkg -l | grep -q "^ii  $pkg "; then
        info "Package $pkg is already installed"
        return 0
    fi
    dry_run "Would install package: $pkg"
    [[ "$DRY_RUN" == "true" ]] && return 0
    apt-get update -qq
    apt-get install -y -qq "$pkg"
    info "Installed $pkg"
}

install_nodejs() {
    if command -v node &>/dev/null && node --version | grep -q "v20"; then
        info "Node.js 20.x is already installed"
        return 0
    fi
    dry_run "Would install Node.js 20.x"
    [[ "$DRY_RUN" == "true" ]] && return 0

    info "Installing Node.js 20.x..."
    # Use NodeSource repository for Node.js 20.x
    apt-get update -qq
    apt-get install -y -qq curl gnupg ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs
    info "Installed Node.js $(node --version)"
}

# ── OpenLDAP installation and configuration ───────────────────────────────────
install_openldap() {
    if command -v slapd &>/dev/null; then
        info "OpenLDAP is already installed"
        return 0
    fi
    dry_run "Would install OpenLDAP"
    [[ "$DRY_RUN" == "true" ]] && return 0

    info "Installing OpenLDAP..."

    # Pre-seed debconf for non-interactive installation
    debconf-set-selections << EOF
slapd slapd/internal/adminpw string $ADMIN_PASS
slapd slapd/password1 string $ADMIN_PASS
slapd slapd/password2 string $ADMIN_PASS
slapd slapd/domain string ${BASE_DN#dc=}
slapd slapd/backend string MDB
slapd shared/organization string $ORG_NAME
slapd slapd/purge_database boolean true
slapd slapd/move_old_database boolean true
slapd slapd/invalid_config boolean true
EOF

    apt-get update -qq
    apt-get install -y -qq slapd ldap-utils

    # Configure ldap.conf
    cat > /etc/ldap/ldap.conf << LDAPCONF
BASE   $BASE_DN
URI    ldap://localhost
LDAPCONF

    # Set proper permissions
    chmod 644 /etc/ldap/ldap.conf

    info "OpenLDAP installed"
}

configure_openldap() {
    info "Configuring OpenLDAP..."
    dry_run "Would configure OpenLDAP with base DN: $BASE_DN"
    [[ "$DRY_RUN" == "true" ]] && return 0

    # Wait for slapd to be ready
    for i in {1..10}; do
        if ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b "cn=config" "(objectClass=*)" dn >/dev/null 2>&1; then
            info "OpenLDAP is ready"
            break
        fi
        sleep 1
    done

    # Detect the database DN for our suffix
    DB_DN=$(ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b "cn=config" \
        "(&(objectClass=olcDatabaseConfig)(olcSuffix=${BASE_DN}))" dn 2>/dev/null \
        | grep "^dn:" | head -1 | sed 's/^dn: //')

    if [[ -z "$DB_DN" ]]; then
        # Try to find any database and update its suffix
        DB_DN=$(ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b "cn=config" \
            "(objectClass=olcDatabaseConfig)" dn 2>/dev/null \
            | grep "^dn:" | head -1 | sed 's/^dn: //')

        if [[ -n "$DB_DN" ]]; then
            info "Updating database suffix to $BASE_DN"
            ldapmodify -Q -Y EXTERNAL -H ldapi:/// << EOF
dn: $DB_DN
changetype: modify
replace: olcSuffix
olcSuffix: $BASE_DN
EOF
        fi
    fi

    if [[ -z "$DB_DN" ]]; then
        error "Could not detect OpenLDAP database configuration"
        return 1
    fi

    info "Using database: $DB_DN"

    # 1. Load pw-sha2 module
    if ! ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b "cn=config" "(objectClass=olcModuleList)" olcModuleLoad 2>/dev/null | grep -q "pw-sha2"; then
        info "Loading pw-sha2 module..."
        ldapmodify -Q -Y EXTERNAL -H ldapi:/// << EOF
dn: cn=module{0},cn=config
changetype: modify
add: olcModuleLoad
olcModuleLoad: pw-sha2
EOF
    else
        info "pw-sha2 module already loaded"
    fi

    # 2. Load ppolicy module
    if ! ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b "cn=config" "(objectClass=olcModuleList)" olcModuleLoad 2>/dev/null | grep -q "ppolicy"; then
        info "Loading ppolicy module..."
        ldapmodify -Q -Y EXTERNAL -H ldapi:/// << EOF
dn: cn=module{0},cn=config
changetype: modify
add: olcModuleLoad
olcModuleLoad: ppolicy
EOF
    else
        info "ppolicy module already loaded"
    fi

    # 3. Load memberof module
    if ! ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b "cn=config" "(objectClass=olcModuleList)" olcModuleLoad 2>/dev/null | grep -q "memberof"; then
        info "Loading memberof module..."
        ldapmodify -Q -Y EXTERNAL -H ldapi:/// << EOF
dn: cn=module{1},cn=config
changetype: modify
add: olcModuleLoad
olcModuleLoad: memberof
EOF
    else
        info "memberof module already loaded"
    fi

    # 4. Load refint module
    if ! ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b "cn=config" "(objectClass=olcModuleList)" olcModuleLoad 2>/dev/null | grep -q "refint"; then
        info "Loading refint module..."
        ldapmodify -Q -Y EXTERNAL -H ldapi:/// << EOF
dn: cn=module{1},cn=config
changetype: modify
add: olcModuleLoad
olcModuleLoad: refint
EOF
    else
        info "refint module already loaded"
    fi

    # 5. Add ppolicy overlay
    if ! ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b "$DB_DN" "(olcOverlay=*ppolicy*)" dn 2>/dev/null | grep -qi "ppolicy"; then
        info "Adding ppolicy overlay..."
        ldapadd -Q -Y EXTERNAL -H ldapi:/// << EOF
dn: olcOverlay=ppolicy,$DB_DN
objectClass: olcOverlayConfig
objectClass: olcPPolicyConfig
olcOverlay: ppolicy
olcPPolicyDefault: cn=ppolicy,ou=policies,$BASE_DN
olcPPolicyUseLockout: TRUE
EOF
    else
        info "ppolicy overlay already configured"
    fi

    # 6. Add memberof overlay
    if ! ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b "$DB_DN" "(olcOverlay=*memberof*)" dn 2>/dev/null | grep -qi "memberof"; then
        info "Adding memberof overlay..."
        ldapadd -Q -Y EXTERNAL -H ldapi:/// << EOF
dn: olcOverlay=memberof,$DB_DN
objectClass: olcConfig
objectClass: olcMemberOf
objectClass: olcOverlayConfig
objectClass: top
olcOverlay: memberof
olcMemberOfDangling: ignore
olcMemberOfRefInt: TRUE
olcMemberOfGroupOC: groupOfNames
olcMemberOfMemberAD: member
olcMemberOfMemberOfAD: memberOf
EOF
    else
        info "memberof overlay already configured"
    fi

    # 7. Add refint overlay
    if ! ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b "$DB_DN" "(olcOverlay=*refint*)" dn 2>/dev/null | grep -qi "refint"; then
        info "Adding refint overlay..."
        ldapadd -Q -Y EXTERNAL -H ldapi:/// << EOF
dn: olcOverlay=refint,$DB_DN
objectClass: olcConfig
objectClass: olcOverlayConfig
objectClass: olcRefintConfig
objectClass: top
olcOverlay: refint
olcRefintAttribute: memberof member manager owner
EOF
    else
        info "refint overlay already configured"
    fi

    # 8. Add database indexes
    info "Configuring database indexes..."
    for index in "mail eq,sub" "uid eq,sub" "cn eq,sub" "member eq" "uidNumber eq" "gidNumber eq"; do
        attr=$(echo "$index" | cut -d' ' -f1)
        types=$(echo "$index" | cut -d' ' -f2)
        ldapmodify -Q -Y EXTERNAL -H ldapi:/// << EOF || true
dn: $DB_DN
changetype: modify
add: olcDbIndex
olcDbIndex: $attr $types
EOF
    done

    # 9. Load custom theta42 schema
    if ! ldapsearch -Q -Y EXTERNAL -H ldapi:/// -b "cn=schema,cn=config" "(olcObjectClasses=*theta42Person*)" olcObjectClasses 2>/dev/null | grep -q "theta42"; then
        info "Loading custom theta42 schema..."
        ldapadd -Q -Y EXTERNAL -H ldapi:/// << EOF
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
    else
        info "theta42 schema already loaded"
    fi

    # 10. Create base directory structure
    BIND_DN="cn=admin,$BASE_DN"

    # Create base DN if it doesn't exist
    if ! ldapsearch -x -D "$BIND_DN" -w "$ADMIN_PASS" -H ldapi:/// -b "$BASE_DN" -s base "(objectClass=*)" dn 2>/dev/null | grep -q "dn:"; then
        info "Creating base DN structure..."
        DC_VALUE="${BASE_DN#dc=}"
        DC_VALUE="${DC_VALUE%%,*}"

        ldapadd -x -D "$BIND_DN" -w "$ADMIN_PASS" -H ldapi:/// << EOF
dn: $BASE_DN
objectClass: dcObject
objectClass: organization
dc: $DC_VALUE
o: $ORG_NAME
EOF
    else
        info "Base DN already exists"
    fi

    # Create OUs
    for ou in people groups policies; do
        dn="ou=$ou,$BASE_DN"
        if ! ldapsearch -x -D "$BIND_DN" -w "$ADMIN_PASS" -H ldapi:/// -b "$dn" -s base "(objectClass=*)" dn 2>/dev/null | grep -q "dn:"; then
            info "Creating $ou OU..."
            ldapadd -x -D "$BIND_DN" -w "$ADMIN_PASS" -H ldapi:/// << EOF
dn: ou=$ou,$BASE_DN
objectClass: organizationalUnit
ou: $ou
EOF
        else
            info "OU $ou already exists"
        fi
    done

    # 11. Create default ppolicy
    if ! ldapsearch -x -D "$BIND_DN" -w "$ADMIN_PASS" -H ldapi:/// -b "cn=ppolicy,ou=policies,$BASE_DN" -s base "(objectClass=*)" dn 2>/dev/null | grep -q "dn:"; then
        info "Creating default ppolicy..."
        ldapadd -x -D "$BIND_DN" -w "$ADMIN_PASS" -H ldapi:/// << EOF
dn: cn=ppolicy,ou=policies,$BASE_DN
objectClass: top
objectClass: organizationalRole
objectClass: pwdPolicy
cn: ppolicy
pwdAttribute: 2.5.4.35
pwdLockout: FALSE
pwdMustChange: FALSE
pwdAllowUserChange: TRUE
EOF
    else
        info "Default ppolicy already exists"
    fi

    # 12. Create required SSO groups
    for group in app_sso_admin app_sso_invite app_sso_oauth_admin; do
        dn="cn=$group,ou=groups,$BASE_DN"
        if ! ldapsearch -x -D "$BIND_DN" -w "$ADMIN_PASS" -H ldapi:/// -b "$dn" -s base "(objectClass=*)" dn 2>/dev/null | grep -q "dn:"; then
            info "Creating group: $group"
            ldapadd -x -D "$BIND_DN" -w "$ADMIN_PASS" -H ldapi:/// << EOF
dn: $dn
objectClass: groupOfNames
objectClass: top
cn: $group
description: $ORG_NAME $group group
member: $BIND_DN
EOF
        else
            info "Group $group already exists"
        fi
    done

    info "OpenLDAP configuration complete"
}

# ── Application installation ──────────────────────────────────────────────────
install_app() {
    info "Installing SSO Manager application..."
    dry_run "Would install application to $INSTALL_DIR"
    [[ "$DRY_RUN" == "true" ]] && return 0

    # Create installation directory
    mkdir -p "$INSTALL_DIR"

    # Copy application files
    info "Copying application files..."
    cp -r "$SCRIPT_DIR/nodejs/"* "$INSTALL_DIR/"

    # Install npm dependencies
    info "Installing npm dependencies..."
    cd "$INSTALL_DIR"
    npm ci --only=production --quiet

    # Create secrets configuration
    info "Creating application configuration..."
    cat > "$INSTALL_DIR/conf/secrets.js" << SECRETEOF
'use strict';

module.exports = {
    port: $PORT,
    ldap: {
        url: 'ldap://localhost',
        bindDN: 'cn=admin,$BASE_DN',
        bindPassword: '$ADMIN_PASS',
        userBase: 'ou=people,$BASE_DN',
        groupBase: 'ou=groups,$BASE_DN',
    },
    smtp: {
        host: '${SMTP_HOST:-localhost}',
        port: ${SMTP_PORT:-587},
        user: '${SMTP_USER:-}',
        pass: '${SMTP_PASS:-}',
        from: '${ORG_NAME} <noreply@${LDAP_DOMAIN}>',
    },
    voipms: {
        username: '${VOIPMS_USER:-}',
        password: '${VOIPMS_PASS:-}',
        did: '${VOIPMS_DID:-}',
    },
    oauth: {
        issuer: '',
        jwtSecret: '$JWT_SECRET',
        token_lifetime: {
            access_token: 3600,
            refresh_token: 2592000
        }
    },
};
SECRETEOF

    # Create base configuration
    cat > "$INSTALL_DIR/conf/base.js" << BASEEOF
'use strict';

module.exports = {
    name: "$ORG_NAME",
    userModel: 'ldap',
    redis: {
        prefix: 'sso_manager_'
    },
    ldap: {
        url: 'ldap://localhost',
        bindDN: 'cn=admin,$BASE_DN',
        bindPassword: '__IN SECRETS FILE__',
        userBase: 'ou=people,$BASE_DN',
        groupBase: 'ou=groups,$BASE_DN',
        userFilter: '(objectClass=posixAccount)',
        userNameAttribute: 'uid'
    },
    oauth: {
        issuer: '',
        jwtSecret: '__in secrets file__',
        token_lifetime: {
            access_token: 3600,
            refresh_token: 2592000
        }
    },
    smtp: {
        host: 'localhost',
        port: 587,
        secure: false,
        from: '$ORG_NAME <noreply@$LDAP_DOMAIN>',
    },
};
BASEEOF

    # Set ownership
    chown -R root:root "$INSTALL_DIR"
    chmod -R 755 "$INSTALL_DIR"

    info "Application installed to $INSTALL_DIR"
}

# ── Systemd service configuration ─────────────────────────────────────────────
install_systemd() {
    info "Installing systemd service..."
    dry_run "Would install systemd service"
    [[ "$DRY_RUN" == "true" ]] && return 0

    cat > "$SYSTEMD_DIR/sso-manager.service" << UNITEOF
[Unit]
Description=Theta42 SSO Manager
Documentation=file://$INSTALL_DIR/README.md
After=network.target slapd.service
Wants=slapd.service

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node $INSTALL_DIR/bin/www
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=NODE_PORT=$PORT

# Security hardening
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNITEOF

    systemctl daemon-reload
    systemctl enable sso-manager.service

    info "Systemd service installed"
}

# ── Verification ──────────────────────────────────────────────────────────────
verify_installation() {
    info "Verifying installation..."

    local errors=0

    # Check OpenLDAP
    if command -v slapd &>/dev/null; then
        if systemctl is-active --quiet slapd; then
            info "✓ OpenLDAP is running"
        else
            warn "✗ OpenLDAP is not running"
            ((errors++))
        fi
    else
        warn "✗ OpenLDAP is not installed"
        ((errors++))
    fi

    # Check application
    if [[ -d "$INSTALL_DIR" ]]; then
        info "✓ Application is installed"
    else
        warn "✗ Application is not installed"
        ((errors++))
    fi

    # Check systemd service
    if systemctl is-enabled --quiet sso-manager.service 2>/dev/null; then
        info "✓ Systemd service is enabled"
    else
        warn "✗ Systemd service is not enabled"
        ((errors++))
    fi

    if [[ $errors -eq 0 ]]; then
        info "Installation verified successfully"
    else
        warn "Installation completed with $errors issue(s)"
    fi

    return $errors
}

# ── Main execution ────────────────────────────────────────────────────────────
main() {
    echo
    echo "=============================================="
    echo "  Theta42 SSO Manager Installer"
    echo "=============================================="
    echo
    echo "Configuration:"
    echo "  Base DN:     $BASE_DN"
    echo "  Port:        $PORT"
    echo "  Install dir: $INSTALL_DIR"
    echo "  Skip LDAP:   $SKIP_LDAP"
    echo "  Skip App:    $SKIP_APP"
    echo

    check_root
    check_os

    if [[ "$SKIP_LDAP" != "true" ]]; then
        echo
        info "=== Installing OpenLDAP ==="
        install_openldap
        configure_openldap
    fi

    if [[ "$SKIP_APP" != "true" ]]; then
        echo
        info "=== Installing SSO Manager ==="
        install_nodejs
        install_app
        install_systemd
    fi

    echo
    verify_installation

    echo
    echo "=============================================="
    echo "  Installation Complete!"
    echo "=============================================="
    echo

    if [[ "$SKIP_APP" != "true" ]]; then
        info "Start the service with: systemctl start sso-manager"
        info "View logs with: journalctl -fu sso-manager"
        info "Access the UI at: http://localhost:$PORT"
    fi

    if [[ "$SKIP_LDAP" != "true" ]]; then
        echo
        info "LDAP Configuration:"
        info "  Base DN:     $BASE_DN"
        info "  Bind DN:     cn=admin,$BASE_DN"
        info "  Admin pass:  (set by you)"
        echo
        info "Required SSO groups created:"
        info "  - app_sso_admin"
        info "  - app_sso_invite"
        info "  - app_sso_oauth_admin"
    fi

    echo
}

main
