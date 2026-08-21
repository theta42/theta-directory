---
layout: default
title: Geo-Location Scaling (Replication)
---

# Geo-Location Scaling (Replication)

SSO Manager is built to be a self-contained identity provider, but if you have multiple physical sites, you may want a local copy of the directory at each site to ensure low latency and high availability.

## Why and when to use this?
- **High Availability (HA)**: If your primary site goes completely offline, your other sites can still authenticate users locally without depending on a WAN link.
- **Low Latency**: Applications at a remote site can bind directly to their local LDAP server (`localhost` or LAN IP) instead of traversing the internet to query the primary site, making logins blazing fast.
- **Independent Failure Domains**: By replicating only the LDAP directory (the source of truth) and keeping session state (Redis) independent, you prevent complex "split-brain" scenarios in the web UI. A failure at Site A won't bring down Site B.

By default, the `sso-manager` Docker container runs a single, independent OpenLDAP instance. However, you can enable **N-Way Multi-Master Replication** via environment variables.

## How it works

In an N-Way Multi-Master setup, every site runs a fully active OpenLDAP server (`slapd`).
- **Reads and Writes anywhere**: A user can change their password or update their profile at Site A, Site B, or Site C.
- **Independent Redis**: Session data and short-lived tokens are stored in Redis. By design, Redis is NOT replicated in this geographic setup. This ensures that a failure at Site A never causes Site B's Redis to become read-only, which would break the web UI at Site B. API Tokens (PATs) and the Directory Resource Catalog are stored in the replicated SQLite database and synchronized across all sites. OAuth clients must be configured per-site.

## Configuration

The container's entrypoint reads two environment variables to configure this
-- `LDAP_SERVER_ID` (a unique integer for this node) and
`LDAP_REPLICATION_HOSTS` (a space-separated list of every **other** node's
LDAP URL) -- and, when both are set, automatically loads the `syncprov`
module, enables `mirrormode`, and generates the necessary `syncrepl` blocks
in `/etc/openldap/slapd.conf`.

**If you're using `theta-suite`'s `setup.sh`, you don't set these by hand.**
The master assigns each spoke a unique `LDAP_SERVER_ID` at join time (the
same way it assigns a WireGuard mesh index), and `LDAP_REPLICATION_HOSTS` is
derived automatically from every site's **mesh address** -- see
`GET /api/site/ldap-peers` (spoke) and
`GET /api/directory-admin/ldap-replication-config` (master), and
`theta-suite`'s `bootstrap/site-ldap-register.js`, which re-checks on every
`setup.sh` run since the peer list changes as new spokes join.

### Replication rides the WireGuard mesh

LDAP replication is **never exposed to the public internet**. Every site is a
mesh node (each is a potential exit), so each site's directory is dialled at
its mesh address over **plain LDAP** (`ldap://10.<siteId>.0.2:389`) -- the
WireGuard tunnel is already encrypted end-to-end, so there is no need for TLS
on top of it, and LDAPS with a certificate bound to a hostname does not work
over a bare mesh IP anyway. The same mesh preference applies to the live
resync push (`utils/site_replicate.js`).

Setting the two env vars directly still works (e.g. a non-`theta-suite`
deployment) -- example using three manually-configured nodes:

**Site 1**
```env
LDAP_SERVER_ID=1
LDAP_REPLICATION_HOSTS="ldap://10.2.0.2:389 ldap://10.3.0.2:389"
```

**Site 2**
```env
LDAP_SERVER_ID=2
LDAP_REPLICATION_HOSTS="ldap://10.1.0.2:389 ldap://10.3.0.2:389"
```

**Site 3**
```env
LDAP_SERVER_ID=3
LDAP_REPLICATION_HOSTS="ldap://10.1.0.2:389 ldap://10.2.0.2:389"
```

**A known limitation of the automatic path**: the *master's* own
`LDAP_REPLICATION_HOSTS` only gets recomputed when its `setup.sh` is
re-run (or the operator re-applies it directly) -- there's no live push
telling the master's already-running container about a spoke that joined
five minutes ago. A spoke's own config, by contrast, is re-checked and
applied on every `setup.sh` run there, which is the common/recurring event.
Re-run `setup.sh` on the master after bringing up a new spoke to pick up the
new peer and restart replication with it.

## User Locations

When creating or editing a user, you can specify their **Location (Site)**. This maps directly to the standard LDAP `l` (localityName) attribute, allowing you to track which physical site a user belongs to natively within the directory.
