# Multi-Site: Joining a Spoke to the Master Directory

The Directory can be deployed across multiple sites. The **master** site holds
single write authority for the shared catalog; **spoke** sites run a read-only
copy for local latency and autonomy (see the root `MULTI_SITE_SPEC.md` for the
full architecture). This page covers the server endpoints that make a spoke
"join" an existing master.

> Status: **server endpoints only.** The `setup.sh` wiring and the UI that calls
> them are the next layer; the join is designed to run during a fresh bring-up
> (before the bootstrap seeds local content), so there is nothing local to wipe
> when adopting the master's directory.

## The flow

1. On the **master**, an admin mints a **site join key** (`stj_…`, shown once,
   stored hashed, revocable).
2. On the **spoke** (a fresh install), an admin calls `POST /api/site/join`
   with the master's URL + that key.
3. The spoke pulls the master's directory export (LDAP tree + resource
   catalog), imports it, and persists its own spoke role
   (`isMaster: false`, `masterUrl`, `siteSlug`).

## Endpoints

### Join key management (admin session)

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/site/join-keys` | List keys (prefix + usage only; never the key) |
| `POST` | `/api/site/join-keys` | Mint one — returned **once** |
| `POST` | `/api/site/join-keys/:id/revoke` | Stop it accepting new joins |
| `DELETE` | `/api/site/join-keys/:id` | Remove it |
| `GET` | `/api/site/config` | Current role (isMaster, masterUrl, siteSlug) |

Mint a key:

```bash
curl -H "Authorization: Bearer $SESSION_TOKEN" \
  -X POST https://sso.master.example.com/api/site/join-keys \
  -H 'Content-Type: application/json' -d '{"label":"staten-island"}'
# -> { "joinKey": {...}, "key": "stj_9f2e..." }   # show `key` once
```

### Export (master side — no admin session)

`POST /api/site/export` authenticated with a site join key
(`Authorization: Bearer stj_…`). Returns the local LDAP tree as an LDIF
(`slapcat`), the resource catalog (`Resource` + `ResourceEdge` rows), the site
slug, and the LDAP base DN. The spoke's join endpoint calls this.

### Join (spoke side — admin session)

`POST /api/site/join` with:

```json
{ "masterUrl": "https://sso.master.example.com", "joinKey": "stj_9f2e..." }
```

The spoke:

1. **Imports the resource catalog** — resources are upserted by slug (the
   master is authoritative for the shared catalog) and edges are recreated.
2. **Imports the LDAP tree** — the master's LDIF is loaded into the local
   slapd with `ldapadd -c`, so the spoke keeps its own `cn=admin` / base DN and
   inherits the master's users/groups.
3. **Persists the spoke role** in `/config/site.json` (survives restarts).

The join is refused if this node is already a spoke (no re-join).

## Deployment (setup.sh wiring — next layer)

`setup.env` will carry the intent so the join runs only on a **fresh** bring-up:

```
# Multi-site: join an existing (master) deployment instead of seeding a fresh one.
# Honored ONLY on first run; re-runs ignore it once ./config/ exists.
#CFG_MASTER_DIRECTORY_URL=https://sso.master.example.com
#CFG_MASTER_DIRECTORY_JOIN_KEY=stj_9f2e...
```

The role itself is seeded from the environment (`IS_MASTER`, `MASTER_URL`,
`SITE_SLUG`) and overridden by `/config/site.json` once a promote/join writes it.

## Security

- Join keys are single-use-intent credentials: shown once, stored as a SHA-256
  hash, revocable/expirable — the same model as agent join keys.
- The export endpoint never returns admin secrets; it returns the LDAP tree +
  resource catalog the spoke needs to operate.
- Join is admin-gated on the spoke and key-gated on the master.
