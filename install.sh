#!/usr/bin/env bash
#
# Install / update Theta42 SSO Manager on a fresh or existing host.
#
# This script is idempotent: run it to install, and re-run it to update. It
# installs system dependencies (Node, OpenLDAP, Redis), force-syncs the repo at
# $REPO_DIR to its remote branch, and symlinks the systemd config straight from
# the repo. Because the config is symlinked, an update is just "sync the repo +
# restart" -- the files under /etc/systemd always track the repo.
#
# Secrets live at $SECRETS_FILE (/etc/sso-manager/secrets.js by default),
# outside the repo checkout so they survive the hard reset below. FIRST RUN
# ONLY (no $SECRETS_FILE yet): installs and configures OpenLDAP (modules,
# overlays, custom schema, directory tree, required SSO groups -- see
# ops/ldap-setup.sh), generates an LDAP admin password + JWT secret unless
# given via env, and seeds $SECRETS_FILE with those values plus SMTP
# placeholders. Edit that file (SMTP, org name, ...) and re-run this script to
# apply changes -- once it exists it is never touched again, and LDAP is never
# re-bootstrapped.
#
# Intended to be driven by CI/CD with no human writes on prod: the checkout is
# hard-reset to origin/$BRANCH on every run, so the box deterministically
# mirrors the repo (any drift on the box is discarded).
#
# Usage: sudo ./install.sh   (override with REPO_URL=, REPO_DIR=, BRANCH=,
#                             SECRETS_FILE=, LDAP_BASE_DN=, LDAP_ADMIN_PASS=,
#                             JWT_SECRET=, ORG_NAME=, PORT=, SKIP_LDAP=true)
set -euo pipefail
# Never block on an interactive git credential prompt in CI.
export GIT_TERMINAL_PROMPT=0
# Never block on an interactive debconf prompt (e.g. tzdata, pulled in as a
# dependency of redis-server/slapd on a box that's never configured it).
export DEBIAN_FRONTEND=noninteractive

REPO_URL="${REPO_URL:-https://github.com/theta42/sso-manager-node.git}"
REPO_DIR="${REPO_DIR:-/opt/theta42/sso-manager}"
BRANCH="${BRANCH:-master}"
NODE_MAJOR=22
SECRETS_FILE="${SECRETS_FILE:-/etc/sso-manager/secrets.js}"

LDAP_BASE_DN="${LDAP_BASE_DN:-dc=example,dc=com}"
ORG_NAME="${ORG_NAME:-SSO Manager}"
PORT="${PORT:-3001}"
SKIP_LDAP="${SKIP_LDAP:-false}"

if [ "$(id -u)" -ne 0 ]; then
	echo "This script must be run as root (try: sudo $0)" >&2
	exit 1
fi

# Symlink $1 -> $2, replacing whatever is already at $2 (idempotent).
link(){
	ln -sfn "$1" "$2"
	echo "linked $2 -> $1"
}

# Read the "version" field out of a package.json without depending on Node
# being installed yet (this runs before the Node.js install step below).
pkg_version(){
	sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1
}

# Installed version before this run touches anything, for the upgrade banner
# at the end. Empty on a fresh install (no prior checkout).
CURRENT_VERSION=""
if [ -f "$REPO_DIR/nodejs/package.json" ]; then
	CURRENT_VERSION="$(pkg_version "$REPO_DIR/nodejs/package.json")"
fi

# FIRST_RUN gates OpenLDAP bootstrap + secrets seeding below -- both only ever
# happen once, the first time this script runs on a host (i.e. before
# $SECRETS_FILE exists). Every later run only updates the code.
FIRST_RUN=0
[ -f "$SECRETS_FILE" ] || FIRST_RUN=1

echo "==> Base packages"
apt-get update
apt-get install -y --no-install-recommends \
	build-essential redis-server \
	wget gnupg ca-certificates curl git

echo "==> Node.js ${NODE_MAJOR}.x apt source"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
	| gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
	> /etc/apt/sources.list.d/nodesource.list

echo "==> Install Node.js"
apt-get update
apt-get install -y nodejs

echo "==> Redis"
systemctl enable --now redis-server

echo "==> Repo checkout at ${REPO_DIR} (branch ${BRANCH})"
install -d "$(dirname "$REPO_DIR")"
if [ -d "$REPO_DIR/.git" ]; then
	# Force the box to match the remote branch exactly. No human edits configs
	# on prod, so discarding local drift is the desired, deterministic behavior.
	git -C "$REPO_DIR" fetch --prune origin
	git -C "$REPO_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
	git -C "$REPO_DIR" reset --hard "origin/$BRANCH"
	git -C "$REPO_DIR" clean -fd
else
	git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi

NEW_VERSION="$(pkg_version "$REPO_DIR/nodejs/package.json")"

if [ "$FIRST_RUN" -eq 1 ] && [ "$SKIP_LDAP" != "true" ]; then
	echo "==> First run: bootstrapping OpenLDAP (base DN: ${LDAP_BASE_DN})"
	LDAP_ADMIN_PASS="${LDAP_ADMIN_PASS:-$(openssl rand -base64 24 | tr -d '=+/')}"
	JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"
	BIND_DN="cn=admin,${LDAP_BASE_DN}"
	# slapd/domain wants a dotted DNS domain (e.g. "example.com"), not the raw
	# DN -- "dc=foo,dc=bar" -> "foo.bar". A malformed value here (e.g. the raw
	# DN with only the leading "dc=" stripped) makes slapd's postinst hang
	# indefinitely instead of failing cleanly.
	LDAP_DOMAIN="$(echo "$LDAP_BASE_DN" | sed 's/^dc=//; s/,dc=/./g')"

	if ! command -v slapd >/dev/null 2>&1; then
		debconf-set-selections <<-EOF
		slapd slapd/internal/adminpw password ${LDAP_ADMIN_PASS}
		slapd slapd/password1 password ${LDAP_ADMIN_PASS}
		slapd slapd/password2 password ${LDAP_ADMIN_PASS}
		slapd slapd/domain string ${LDAP_DOMAIN}
		slapd shared/organization string ${ORG_NAME}
		slapd slapd/purge_database boolean true
		slapd slapd/move_old_database boolean true
		EOF
		apt-get install -y slapd ldap-utils
		cat > /etc/ldap/ldap.conf <<-EOF
		BASE   ${LDAP_BASE_DN}
		URI    ldap://localhost
		EOF
		systemctl enable --now slapd
	else
		echo "    slapd already installed -- assuming it already serves ${LDAP_BASE_DN}"
	fi

	echo "==> Directory structure (ou=people, ou=groups)"
	for ou in people groups; do
		dn="ou=${ou},${LDAP_BASE_DN}"
		if ldapsearch -x -D "$BIND_DN" -w "$LDAP_ADMIN_PASS" -H ldap://localhost -b "$dn" -s base "(objectClass=*)" dn 2>/dev/null | grep -q "^dn:"; then
			echo "    ${dn} already exists"
		else
			ldapadd -x -D "$BIND_DN" -w "$LDAP_ADMIN_PASS" -H ldap://localhost <<-EOF
			dn: ${dn}
			objectClass: organizationalUnit
			ou: ${ou}
			EOF
			echo "    ${dn} created"
		fi
	done

	echo "==> LDAP modules, overlays, schema, policy, SSO groups"
	"$REPO_DIR/ops/ldap-setup.sh" -p "$LDAP_ADMIN_PASS" -b "$LDAP_BASE_DN" -D "$BIND_DN"

	echo "==> Seeding ${SECRETS_FILE}"
	install -d -m 0750 "$(dirname "$SECRETS_FILE")"
	cat > "$SECRETS_FILE" <<-SECRETSEOF
	'use strict';

	// Generated by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Edit freely --
	// this file is never overwritten by a later run of install.sh.
	// LDAP admin password + JWT secret below were auto-generated; SMTP is a
	// placeholder (email delivery won't work until you fill it in).

	module.exports = {
	    port: ${PORT},
	    name: '${ORG_NAME}',
	    ldap: {
	        url: 'ldap://localhost',
	        bindDN: '${BIND_DN}',
	        bindPassword: '${LDAP_ADMIN_PASS}',
	        userBase: 'ou=people,${LDAP_BASE_DN}',
	        groupBase: 'ou=groups,${LDAP_BASE_DN}',
	    },
	    smtp: {
	        host: 'smtp.example.com',
	        port: 587,
	        secure: false,
	        user: 'noreply@${LDAP_DOMAIN}',
	        pass: 'set-me',
	        from: '${ORG_NAME} <noreply@${LDAP_DOMAIN}>',
	    },
	    oauth: {
	        issuer: '',
	        jwtSecret: '${JWT_SECRET}',
	        token_lifetime: {
	            access_token: 3600,
	            refresh_token: 2592000,
	        },
	    },
	};
	SECRETSEOF
	chmod 600 "$SECRETS_FILE"
	echo "    seeded ${SECRETS_FILE} (LDAP + JWT are live; SMTP is a placeholder)"
	echo "        \$EDITOR ${SECRETS_FILE}"
	echo "    then re-run this script (or: sudo systemctl restart sso-manager)"
elif [ "$FIRST_RUN" -eq 1 ]; then
	echo "==> SKIP_LDAP=true -- not bootstrapping OpenLDAP or seeding ${SECRETS_FILE}"
	echo "    Write it yourself (see secrets.js.example) before starting sso-manager."
else
	echo "==> ${SECRETS_FILE} already exists, leaving LDAP + secrets untouched"
fi

echo "==> Symlink systemd config from the repo"
link "$REPO_DIR/ops/systemd/sso-manager.service" /etc/systemd/system/sso-manager.service

echo "==> Node dependencies"
# Deterministic, production-only install from the lockfile. Falls back to a
# plain install if the lockfile and manifest are out of step.
( cd "$REPO_DIR/nodejs" && { npm ci --omit=dev || npm install --omit=dev; } )

echo "==> Services"
systemctl daemon-reload
systemctl enable --now sso-manager.service
systemctl restart sso-manager.service

echo "==> Done."
if [ -z "$CURRENT_VERSION" ]; then
	echo "    Installed v${NEW_VERSION}."
elif [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
	echo "    Already up to date (v${NEW_VERSION})."
else
	echo "    Updated v${CURRENT_VERSION} -> v${NEW_VERSION}."
fi
echo "    Update later with: sudo BRANCH=${BRANCH} $0"
