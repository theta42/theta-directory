#!/bin/bash
# Standalone backup for a Docker-deployed SSO Manager (container name
# "sso-manager").
#
# Snapshots the LDAP directory (slapcat), Redis (OAuth clients, tokens,
# sessions), and ./config (secrets) to ./backups/<timestamp>/, then prunes
# old backups beyond BACKUP_KEEP.
#
# If you run this as part of the unified theta-env stack, use theta-env's
# own setup.sh instead -- it already does this (and more, for both
# containers at once) before every rebuild. This script is for a standalone
# `docker compose up` deployment.
#
# Usage: ./ops/backup.sh [BACKUP_KEEP]
#   BACKUP_KEEP  how many timestamped backups to retain (default 5; env var
#                of the same name also works, matching theta-env's setup.sh)

set -euo pipefail

CONTAINER="${CONTAINER:-sso-manager}"
BACKUP_ROOT="${BACKUP_ROOT:-./backups}"
BACKUP_KEEP="${1:-${BACKUP_KEEP:-5}}"

info() { printf '\033[1;34m[backup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[backup]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[backup]\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker not found"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "container '$CONTAINER' not found -- is the stack running? (docker compose up -d)"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
dest="${BACKUP_ROOT}/${ts}"
mkdir -p "$dest"
chmod 700 "$dest"

# LDAP -- slapcat the live directory while slapd is running. Read the base DN
# from the host-side config first (works whether or not the running
# container has /config mounted), then fall back to reading it inside the
# container, matching theta-env's setup.sh.
info "Snapshotting LDAP..."
basedn=""
if [ -f ./config/sso-secrets.js ] && command -v node >/dev/null 2>&1; then
	basedn="$(timeout 5 node -e 'console.log((require(process.cwd()+"/config/sso-secrets.js").stack||{}).ldapBaseDn||"")' 2>/dev/null || true)"
fi
if [ -z "$basedn" ]; then
	basedn="$(docker exec "$CONTAINER" node -e 'console.log((require("/config/sso-secrets.js").stack||{}).ldapBaseDn||"")' 2>/dev/null || true)"
fi
if [ -n "$basedn" ] && timeout 20 docker exec "$CONTAINER" slapcat -f /etc/openldap/slapd.conf -b "$basedn" > "${dest}/ldap.ldif" 2>/dev/null; then
	info "  -> ${dest}/ldap.ldif (${basedn})"
else
	rm -f "${dest}/ldap.ldif"
	warn "  could not determine base DN or slapcat failed -- LDAP not snapshotted"
fi

info "Snapshotting Redis (BGSAVE)..."
# Capture LASTSAVE *before* issuing BGSAVE: a small dataset finishes in well
# under a second, so capturing it afterward races the save and the poll below
# can miss the update entirely (looks like "BGSAVE never finished" when it
# actually finished immediately).
before="$(docker exec "$CONTAINER" redis-cli LASTSAVE 2>/dev/null | tr -dc '0-9' || echo 0)"
docker exec "$CONTAINER" redis-cli BGSAVE >/dev/null 2>&1 || true
ok=0
for _ in $(seq 1 10); do
	after="$(docker exec "$CONTAINER" redis-cli LASTSAVE 2>/dev/null | tr -dc '0-9' || echo 0)"
	if [ "${after:-0}" -gt "${before:-0}" ]; then ok=1; break; fi
	sleep 1
done
if [ "$ok" != "1" ]; then
	info "BGSAVE didn't complete in time -- falling back to a synchronous SAVE."
	[ "$(docker exec "$CONTAINER" redis-cli SAVE 2>/dev/null | tr -d '\r\n')" = "OK" ] && ok=1
fi

if [ "$ok" = "1" ]; then
	# Ask Redis where it actually wrote the RDB rather than assuming a fixed
	# path -- the all-in-one image keeps it at /app/dump.rdb, not /data.
	rdir="$(docker exec "$CONTAINER" redis-cli CONFIG GET dir 2>/dev/null | sed -n '2p' | tr -d '\r\n')"
	rfile="$(docker exec "$CONTAINER" redis-cli CONFIG GET dbfilename 2>/dev/null | sed -n '2p' | tr -d '\r\n')"
	rpath="${rdir:+$rdir/}${rfile:-dump.rdb}"
	if docker cp "${CONTAINER}:${rpath}" "${dest}/sso-manager.rdb" >/dev/null 2>&1; then
		info "  -> ${dest}/sso-manager.rdb"
	else
		warn "  could not copy ${rpath} from the container -- Redis not snapshotted"
	fi
else
	warn "  Redis snapshot failed -- not included in this backup"
fi

if [ -d ./config ]; then
	info "Copying ./config..."
	cp -a ./config "${dest}/config"
	info "  -> ${dest}/config"
else
	warn "No ./config directory found here -- skipping (secrets aren't managed from this path?)."
fi

if [ -n "${BACKUP_KEEP}" ] && [ "${BACKUP_KEEP}" -gt 0 ] 2>/dev/null; then
	info "Pruning old backups, keeping the newest ${BACKUP_KEEP}..."
	# shellcheck disable=SC2012
	ls -1dt "${BACKUP_ROOT}"/*/ 2>/dev/null | tail -n "+$((BACKUP_KEEP + 1))" | while read -r old; do
		[ -L "${old%/}" ] && continue
		info "  removing ${old}"
		rm -rf "${old}"
	done
fi

info "Done: ${dest}"
info "Store this off-host -- it contains the whole user directory and every secret (LDAP admin pass, JWT secret, SMTP)."
