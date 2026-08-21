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
   catalog + agent fleet + API tokens + user verifications + shared OpenBao secrets + agent-signing key),
   imports it, and persists its own spoke role (`isMaster: false`, `masterUrl`, `siteSlug`) in `/config/site.json`.
4. If the spoke also knows its own reachable URL (`selfUrl` — `setup.sh` passes
   `https://$CFG_SSO_HOST` automatically), it registers itself with the master
   (`POST /api/site/spokes`) so the master can push live updates back to it
   afterward — see **Live replication** below. Without `selfUrl` the join still
   succeeds; the spoke just stays a one-time snapshot.

Joining is allowed only on a **fresh install** (no users beyond the bootstrap
admin, no enrolled agents) — the join endpoint enforces this, so a populated
directory can never be merged into a master's.

## Live replication (not a one-time snapshot)

A registered spoke stays in sync: every successful catalog, user, group, API token, or agent write on the
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
3. The demote response hands over the outgoing master's **spoke registry** —
   every other site's endpoint, siteSlug, assigned `ldapServerId`, relay
   details, and `pushToken`. The promoting node writes those into its own
   registry (preserving each `ldapServerId` where it doesn't collide with one
   it already uses, and never keeping `1`, which is now its own) and then
   calls `POST /api/site/master-changed` on each of them to re-point it.
4. Every known spoke gets a fire-and-forget `master-promoted` resync ping so
   they pick up the new master on their next sync.

Step 3 is what makes promotion work in a cluster with more than two sites.
Without it the promoted node — which was a spoke, so its own registry is
empty — came up as a master believing it had no spokes, while every sibling
kept replicating from the node that had just been demoted. Two-site clusters
happened to work regardless (the demoted master re-registers itself), which
is why this went unnoticed.

The `pushToken`s travel with the registry deliberately. They are the
master→spoke credential, and the demote call is already authenticated with a
site join key — the credential that authorizes "stop being master at all" and
can already pull a full directory export. Withholding them would buy nothing
and would instead force every spoke to accept a re-point from a node it has
no established relationship with.

The response's `siblings` field reports `{inherited, adopted, repointed,
orphaned, detail}`. **`orphaned > 0` needs operator action**: those sites are
still pointed at the demoted master. The usual cause is a promotion done
while the old master was unreachable, so there was no registry to inherit —
recover by re-registering each remaining spoke against the new master
(`POST /api/site/reregister` on that spoke, or the modal's **Re-register**).

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
| `POST` | `/api/site/demote` | Step down to spoke of a new master, returning this node's spoke registry for the new master to inherit (Bearer `stj_` key, called by the newly-promoted node) |
| `POST` | `/api/site/master-changed` | Follow a newly-promoted master: re-point, re-register, resync (Bearer this spoke's own `pushToken`, called by the new master during promotion) |
| `POST` | `/api/site/reregister` | Re-run only the registration half of a join, using stored master credentials (admin session, spoke only) |
| `GET` | `/api/site/spokes` | List registered spokes (admin session; never includes `pushToken`) |
| `DELETE` | `/api/site/spokes/:id` | Remove a spoke from the registry, freeing its `ldapServerId` (admin session, master only) |
| `POST` | `/api/site/spokes/resync` | Push a resync now, to one spoke (`{id}`) or all; **awaits** each result so reachability is reported honestly (admin session, master only) |
| `POST` | `/api/directory-admin/site-promote` | Promote this node to master, coordinating demotion of the old one and inheriting its spoke registry (`god_admin` session) |

### ServerID allocation

Each spoke is assigned the lowest free `ldapServerId` at registration (1 is
the master's). That is a read-then-write, so it is serialized by
`utils/mutex.js` — but the lock is process-local and would protect nothing if
this app were run as two processes against one database, so the actual
guarantee is a unique index on `SiteSpoke.ldapServerId`, added at boot by
`models/index.js`'s `ensureUniqueIndexes()`.

The index has to be added explicitly: `@simpleworkjs/orm` only forwards a
field's `unique: true` for string fields, and it calls `sequelize.sync()` with
no options, which never alters an existing table. (The same reason
`healSchema()` exists — and the reason `SiteSpoke.endpoint`'s declared
constraint does not exist on any site deployed before this.)

A master upgrading from a build that predates the index may already hold
duplicates, which would make `addIndex` fail. `repairDuplicateServerIds()`
runs first: the oldest registration keeps the ID, the rest are moved to free
ones and log a line each. That is safe unattended because a spoke does not
store its ServerID authoritatively — it re-reads it from
`GET /api/site/ldap-peers` on every reconcile — and a duplicate is already a
broken replica, so leaving it alone is not the more conservative option.

`utils/mutex.js` refuses re-entry rather than deadlocking: taking the same
lock from inside a critical section throws, and a lock held across an
outbound call that comes back into the same route fails with an acquisition
timeout naming the holder. Both used to be an unanswered request, and the
error surfaced on the *other* node as an unrelated-looking fetch abort.

### LDAP replication config is applied live

`slapd` runs from the **`cn=config` dynamic backend** — `docker-entrypoint.sh`
still generates the same `slapd.conf` as the seed (schema, overlays, ACLs,
TLS), then converts it with `slaptest -f … -F /etc/openldap/slapd.d` and runs
`slapd -F` against the result. That is what makes `olcServerID` and
`olcSyncrepl` modifiable while the server is running.

`utils/ldap_runtime_config.js` converges the running config on a desired
`{serverId, peers}`: it reads what is configured, computes the delta, and
issues only the modifications needed, so re-applying the same state is a
no-op. `utils/ldap_reconcile.js` decides what that desired state is (a master
computes it from its own registry; a spoke asks the master via
`GET /api/site/ldap-peers`) and triggers it on every event that can change it
— spoke registered/removed, join, resync, master-changed, promotion, boot —
plus a periodic sweep for anything no event covers.

**No `setup.sh` re-run, no restart, on any node.** A site that was offline
while the cluster changed converges when it comes back. Three details worth
knowing, each learned the hard way against a real server:

- `olcSyncrepl` is X-ORDERED: the `{n}` prefix slapd stores is the ordering
  position, *not* the rid. Values are written without a prefix, and the whole
  attribute is replaced when the peer set changes — deleting an individual
  peer by `{rid}` fails with "No such attribute", and deleting by position is
  a moving target.
- OpenLDAP 2.6 renamed `olcMirrorMode` to `olcMultiProvider`. It still accepts
  the old name on write but stores and returns the new one, so both are read.
- The mdb database entry is found by `(objectClass=olcMdbConfig)`, not by
  `(olcDatabase=*mdb)` — slapd does not substring-match that attribute, so the
  obvious filter silently returns nothing.

`GET /directory-admin/site-status` reports the live config (`ldap.source` is
`cn=config`) plus a drift comparison against what the cluster advertises. That
comparison is a **fault indicator**, not an operator instruction: under normal
operation it never fires, and when it does, the `[ldap-reconcile]` log lines
say what failed.

### Why `reregister` exists

Registration only ever happened during a join, so any state where the master's
`SiteSpoke` row and the spoke's stored `pushToken` disagree was unrecoverable:
`POST /api/site/join` refuses once a node is a spoke, and requires a fresh
install besides. That state is reachable in ordinary operation — an operator
removes a spoke and wants it back, a row gets recreated with a new token, or
the original join ran without `selfUrl` and left the spoke on a one-time
snapshot. `reregister` re-runs just that step with the credentials the spoke
already holds; it never adopts a directory.

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
- Promotion when the old master is **unreachable** inherits no spoke registry,
  so the remaining spokes stay pointed at the node that is gone. The response
  reports them as `siblings.orphaned`; recovery is per-spoke
  (`POST /api/site/reregister` on each, or the modal's **Re-register**).
- A spoke with **zero inbound and zero outbound** path still cannot join: the
  join itself has to reach the master's API directly.

*(The two `setup.sh` re-run caveats that used to live here — a promoted node's
own ServerID, and every other site's peer list after a join — are gone.
Replication config is applied live against `cn=config` now; see "LDAP
replication config is applied live" above.)*

## Shipped since the above was last stale

- Traffic between sites (`utils/site_replicate.js`'s resync push) rides the
  WireGuard mesh by default: every site is a mesh node, so a spoke with a
  ServerID is dialled at its mesh address (`10.<siteId>.0.2:3001`) over plain
  HTTP, falling back to the public endpoint on failure. The gateway is a real
  router, so the peer's directory is addressed directly — there is no relay
  port and no local-gateway hop to derive (`utils/mesh_route.js`).
- OpenLDAP N-way multi-master replication auto-configures on join and rides
  the mesh too: the master assigns each spoke a unique `LDAP_SERVER_ID` and
  every site's directory is dialled at its mesh address over plain LDAP
  (`ldap://10.<siteId>.0.2:389`), never the public internet
  (`GET /api/site/ldap-peers`, `GET /directory-admin/ldap-replication-config`).
  See `docs/replication.md`.
- A no-inbound spoke (no public IP at all) CAN join: `noInbound`/`meshIp`/
  `publicHost` on `POST /api/site/join` drive `utils/proxy_client.js`, which
  auto-creates/updates the relay route on the master's own `theta-proxy`.
  Mesh peering between the two jump-hosts is still a manual, one-time step
  (see `theta-suite`'s `spoke.env.example` for the operator-facing side).
  A spoke with zero inbound *and* zero outbound path still can't join --
  the join itself needs to reach the master's API directly.
