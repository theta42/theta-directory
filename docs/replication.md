---
layout: default
title: Geo-Location Scaling (Replication)
---

# Geo-Location Scaling (Replication)

SSO Manager is built to be a self-contained identity provider, but if you have multiple physical sites, you may want a local copy of the directory at each site to ensure low latency and high availability.

By default, the `sso-manager` Docker container runs a single, independent OpenLDAP instance. However, you can enable **N-Way Multi-Master Replication** via environment variables.

## How it works

In an N-Way Multi-Master setup, every site runs a fully active OpenLDAP server (`slapd`).
- **Reads and Writes anywhere**: A user can change their password or update their profile at Site A, Site B, or Site C.
- **Conflict Resolution**: OpenLDAP's `syncrepl` engine uses Context Sequence Numbers (CSN) to track changes. If Site A goes offline and a user changes their password at Site B, Site A will automatically pull the newest changes the moment it rejoins the cluster.
- **Independent Redis**: Session data, API Tokens, and OAuth Clients are stored in Redis. By design, Redis is NOT replicated in this geographic setup. This ensures that a failure at Site A never causes Site B's Redis to become read-only, which would break the web UI at Site B. OAuth clients must be configured per-site.

## Configuration

To enable replication, you must pass two environment variables to the `sso-manager` container:

1. `LDAP_SERVER_ID`: A unique integer for this node (e.g., `1`, `2`, `3`). This MUST be unique across the cluster.
2. `LDAP_REPLICATION_HOSTS`: A space-separated list of the LDAP URLs of all **other** nodes in the cluster.

### Example using `theta-env` / Docker Compose

**Site 1 (`setup.env` or `docker-compose.yml`)**
```env
LDAP_SERVER_ID=1
LDAP_REPLICATION_HOSTS="ldaps://sso.site2.com:636 ldaps://sso.site3.com:636"
```

**Site 2 (`setup.env` or `docker-compose.yml`)**
```env
LDAP_SERVER_ID=2
LDAP_REPLICATION_HOSTS="ldaps://sso.site1.com:636 ldaps://sso.site3.com:636"
```

**Site 3 (`setup.env` or `docker-compose.yml`)**
```env
LDAP_SERVER_ID=3
LDAP_REPLICATION_HOSTS="ldaps://sso.site1.com:636 ldaps://sso.site2.com:636"
```

Once configured, the container's entrypoint will automatically load the `syncprov` module, enable `mirrormode`, and generate the necessary `syncrepl` blocks in `/etc/openldap/slapd.conf`.

## User Locations

When creating or editing a user, you can specify their **Location (Site)**. This maps directly to the standard LDAP `l` (localityName) attribute, allowing you to track which physical site a user belongs to natively within the directory.
