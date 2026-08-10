# Multi-Site: Joining a Spoke to the Master Directory

The Directory can be deployed across multiple sites. The **master** site holds
single write authority for the shared catalog; **spoke** sites run a read-only
copy for local latency and autonomy (see the root `MULTI_SITE_SPEC.md` for the
full architecture). This page covers the server endpoints that make a spoke
"join" an existing master.

> Status: **server endpoints + UI + setup.sh wiring.** A fresh bring-up can
> adopt a master directory via the Directory UI or via `setup.env`, and a
> joined spoke is read-only with live WAN health.

## The flow

1. On the **master**, an admin mints a **site join key** (`stj_…`, shown once,
   stored hashed, revocable) — Directory → the Master Site modal → **Site Join Keys**.
2. On the **spoke** (a fresh install), either:
   - **UI**: Directory → the Master Site modal → **Join an Existing Site**, or
   - **setup.sh**: set `CFG_MASTER_DIRECTORY_URL` + `CFG_MASTER_DIRECTORY_JOIN_KEY`
     in `setup.env` before the first run.
3. The spoke pulls the master's directory export (LDAP tree + resource
   catalog), imports it, and persists its own spoke role
   (`isMaster: false`, `masterUrl`, `siteSlug`) in `/config/site.json`.

Joining is allowed only on a **fresh install** (no users beyond the bootstrap
admin, no enrolled agents) — the join endpoint enforces this, so a populated
directory can never be merged into a master's.

## Endpoints

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/site/join-keys` | List keys (prefix + usage only; never the key) |
| `POST` | `/api/site/join-keys` | Mint one — returned **once** |
| `POST` | `/api/site/join-keys/:id/revoke` | Stop it accepting new joins |
| `DELETE` | `/api/site/join-keys/:id` | Remove it |
| `GET` | `/api/site/config` | Current role (isMaster, masterUrl, siteSlug) |
| `POST` | `/api/site/export` | Master directory export (Bearer `stj_` key) |
| `POST` | `/api/site/ping` | Lightweight master reachability probe (Bearer `stj_` key) |
| `POST` | `/api/site/join` | Adopt a master directory (admin session) |

## Behavior after joining (spoke)

- **Read-only**: directory-write requests (resources, edges, groups, secrets,
  grants, driver actions, discovery merges) are rejected with `403` pointing at
  the master. Writes must go to the master.
- **WAN health**: `site-status` pings the master over the stored site join key
  and reports `wanConnected`; the Master Site modal shows live Online/Offline.
- **Role persists**: `isMaster`/`masterUrl`/`siteSlug` live in `/config/site.json`
  (the env vars `IS_MASTER`/`MASTER_URL`/`SITE_SLUG` only seed the defaults), so
  a restart never silently reverts a spoke to master.

## Deployment (setup.sh)

`setup.env` carries the intent so the join runs only on a **fresh** bring-up:

```
# Honored ONLY on first run; re-runs ignore it once ./config/ exists.
CFG_MASTER_DIRECTORY_URL=https://sso.master.example.com
CFG_MASTER_DIRECTORY_JOIN_KEY=stj_9f2e...
```

`setup.sh` runs `bootstrap/site-join.js` inside the sso-manager container after
the bootstrap; it logs in as the admin and calls `/api/site/join`. A node that
already joined reports "already a spoke" and setup continues (idempotent).

## Security

- Join keys are single-use-intent credentials: shown once, stored as a SHA-256
  hash, revocable/expirable — the same model as agent join keys.
- The export/ping endpoints return only the directory tree/catalog (no admin
  secrets) and require a valid join key.
- Join is admin-gated on the spoke, key-gated on the master, and fresh-install
  gated on both sides.
- The join key is stored on the spoke only so it can reach the master for WAN
  health (and, in a later layer, write-proxy).
