# Multi-Site: Joining a Spoke to the Master Directory

The Directory can be deployed across multiple sites. The **master** site holds
single write authority for the shared catalog; **spoke** sites run a read-only
copy for local latency and autonomy (see the root `MULTI_SITE_SPEC.md` for the
full architecture). This page covers the server endpoints that make a spoke
"join" an existing master.

> Status: **server endpoints + UI + setup.sh wiring, live replication, coordinated promotion.** A fresh bring-up can adopt a master directory via the Directory UI or via `setup.env`; a joined spoke is read-only with live WAN health, stays in sync after joining (not just a one-time snapshot), and can be promoted to master with the old master demoted as part of the same action.

## The flow

1. On the **master**, an admin mints a **site join key** (`stj_…`, shown once,
   stored hashed, revocable) — Directory → the Master Site modal → **Site Join Keys**.
2. On the **spoke** (a fresh install), either:
   - **UI**: Directory → the Master Site modal → **Join an Existing Site**, or
   - **setup.sh**: set `CFG_MASTER_DIRECTORY_URL` + `CFG_MASTER_DIRECTORY_JOIN_KEY`
     in `setup.env` before the first run.
3. The spoke pulls the master's directory export (LDAP tree + resource
   catalog + agent-signing key), imports it, and persists its own spoke role
   (`isMaster: false`, `masterUrl`, `siteSlug`) in `/config/site.json`.
4. If the spoke also knows its own reachable URL (`selfUrl` — `setup.sh` passes
   `https://$CFG_SSO_HOST` automatically), it registers itself with the master
   (`POST /api/site/spokes`) so the master can push live updates back to it
   afterward — see **Live replication** below. Without `selfUrl` the join still
   succeeds; the spoke just stays a one-time snapshot.

Joining is allowed only on a **fresh install** (no users beyond the bootstrap
admin, no enrolled agents) — the join endpoint enforces this, so a populated
directory can never be merged into a master's.

## Live replication (not a one-time snapshot)

A registered spoke stays in sync: every successful catalog write on the
master fires a fire-and-forget push (`utils/site_replicate.js`) at every
registered spoke, concurrently — one unreachable spoke never blocks or delays
delivery to another. The spoke's `POST /api/site/resync` handler (called by
that push) re-runs the same export-pull-and-import logic used at join time,
so there's exactly one tested code path for "make my catalog match the
master's," not a separate diff-application mechanism.

The agent-signing key travels the same path: `POST /api/site/export`
best-effort includes it, and the spoke adopts it via `agent_keys.adopt()` on
both join and every resync. Every site holding the same signing key means any
site's `sso-manager-node` can validly sign a command for any agent enrolled
at any other site — a deliberate tradeoff (see `MULTI_SITE_SPEC.md` §2)
accepted for this deployment's small, trusted scale. Don't extend this
pattern to a larger/adversarial-tenant deployment without revisiting it.

## Coordinated master promotion

`POST /api/directory-admin/site-promote` (`god_admin` only) promotes this
node to master as **one coordinated action**, not a manual two-step
demote-then-promote:

1. If this node currently has a master on file, it mints a fresh join key and
   calls that master's `POST /api/site/demote` (authenticated with the join
   key this node already holds), handing over the new key so the demoted node
   can keep talking to the new master afterward.
2. This step is **best-effort** — an unreachable old master (the WAN-outage
   scenario this whole control exists for) never blocks the local promotion.
   The response's `handoff` field reports what happened
   (`"previous master demoted"`, an HTTP failure, or "unreachable, promoted
   locally anyway") so the operator can reconcile it manually if needed.
3. Every known spoke gets a fire-and-forget `master-promoted` resync ping so
   they pick up the new master on their next sync.

The Master Site modal's **Promote to Master** button surfaces the `handoff`
result in a toast so the operator sees immediately whether the old master was
actually reached.

## Endpoints

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/site/join-keys` | List keys (prefix + usage only; never the key) |
| `POST` | `/api/site/join-keys` | Mint one — returned **once** |
| `POST` | `/api/site/join-keys/:id/revoke` | Stop it accepting new joins |
| `DELETE` | `/api/site/join-keys/:id` | Remove it |
| `GET` | `/api/site/config` | Current role (isMaster, masterUrl, siteSlug) |
| `POST` | `/api/site/export` | Master directory export incl. agent-signing key (Bearer `stj_` key) |
| `POST` | `/api/site/ping` | Lightweight master reachability probe (Bearer `stj_` key) |
| `POST` | `/api/site/join` | Adopt a master directory + register for live replication (admin session) |
| `POST` | `/api/site/spokes` | Register a spoke's endpoint for live replication (Bearer `stj_` key, called by the spoke right after join) |
| `POST` | `/api/site/resync` | Re-pull the master's export (Bearer the spoke's own `pushToken`, called by the master's fire-and-forget push) |
| `POST` | `/api/site/demote` | Step down to spoke of a new master (Bearer `stj_` key, called by the newly-promoted node) |
| `POST` | `/api/directory-admin/site-promote` | Promote this node to master, coordinating demotion of the old one (`god_admin` session) |

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
- `pushToken` (the credential a spoke stores so it can recognize a legitimate
  resync push from its master) is minted fresh per spoke registration and, by
  design, kept in retrievable form on the master — unlike a join key, it's a
  credential the master must keep *presenting*, not just verifying, so it
  can't be one-way hashed. Compare `models/site_spoke.js`'s doc comment for
  why that's the correct tradeoff, not an oversight.
- Every site sharing one agent-signing key (see **Live replication** above)
  means a compromised spoke — including the smallest, least-secured one — has
  the same agent-command authority as the master. Accepted for this
  deployment's scale; see `MULTI_SITE_SPEC.md` §2 before reusing this pattern
  somewhere that assumption doesn't hold.

## Not yet built

- OpenBao secret replication covers only the agent-signing key; LDAP admin
  creds, JWT secret, and other per-deployment secrets aren't synced.
- A promoted spoke's own OpenLDAP `ServerID` doesn't apply live -- `POST
  /site-promote` starts advertising `1` for it immediately
  (`GET /directory-admin/ldap-replication-config`), but nothing restarts
  `slapd` with that value automatically (its static `slapd.conf` is only
  read at process start). Re-run `setup.sh` on the newly-promoted node
  promptly after promotion to actually apply it.
- The master's own `LDAP_REPLICATION_HOSTS` peer list only recomputes on
  its next `setup.sh` run, not live the instant a new spoke joins -- same
  re-run-`setup.sh` caveat as above, just triggered by a join instead of a
  promotion.

## Shipped since the above was last stale

- Traffic between sites (`utils/site_replicate.js`'s resync push) prefers a
  registered spoke's WireGuard mesh IP over the open internet when one's on
  file, falling back to the public endpoint on failure.
- A no-inbound spoke (no public IP at all) CAN join: `noInbound`/`meshIp`/
  `publicHost` on `POST /api/site/join` drive `utils/proxy_client.js`, which
  auto-creates/updates the relay route on the master's own `theta-proxy`.
  Mesh peering between the two jump-hosts is still a manual, one-time step
  (see `theta-suite`'s `spoke.env.example` for the operator-facing side).
  A spoke with zero inbound *and* zero outbound path still can't join --
  the join itself needs to reach the master's API directly.
- OpenLDAP N-way multi-master replication now auto-configures on join --
  the master assigns each spoke a unique `LDAP_SERVER_ID` and derives every
  site's `ldaps://` URL automatically (`GET /api/site/ldap-peers`,
  `GET /directory-admin/ldap-replication-config`). See
  `docs/replication.md`.
