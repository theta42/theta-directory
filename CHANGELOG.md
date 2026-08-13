## v2.21.1
- fix: **clicking "Run Import" on the LDIF import page threw an uncaught
  exception instead of showing the confirmation dialog.** `ldif_import.ejs`
  calls `app.messages.confirm(message, null, 'warning')` — that page has no
  inline `.actionMessage` element — and `@simpleworkjs/frontend`'s
  `renderActionHtml` called `.closest()` directly on the null target.
  Bumped to `@simpleworkjs/frontend` v0.4.1, which also fixes `confirm()`
  having no toast fallback at all for a page with no inline target (it
  previously just logged a console warning and left the promise pending
  forever, which would have made the button look broken even after the
  crash itself was fixed).

## v2.21.0
- feat: **`POST /api/site/ping` now reports `baseDn`.** A spoke joining this
  site as master can fetch its LDAP base DN with only the join key it was
  handed — before it has any local LDAP of its own — and derive its
  `CFG_DOMAIN` automatically instead of the operator having to separately
  learn and correctly re-type the master's own domain into a second config
  file. Part of theta-suite's `master.env`/`spoke.env` split (see
  MULTI_SITE_SPEC.md §4): a spoke's `spoke.env` no longer needs `CFG_DOMAIN`
  at all, and a bad/unreachable join key now fails in the first second of
  bring-up instead of after a full local bootstrap.

## v2.20.0
- feat: **register and monitor services of many types.** The Directory now
  reconciles the services an agent registers (`register <type> <name>` for
  systemd, docker, podman, process, systemd-timer, cron, lxc, kvm/libvirt) into
  `service` child resources under the host, keyed by a generic `serviceName` +
  `subType`. Legacy `systemdService`/`dockerContainer` resources are backfilled
  so they keep reconciling in place.
- feat: **per-service live metrics.** The theta-agent driver surfaces each
  service's active state, CPU%, memory, restart count and uptime, plus schedule
  fields (`next_run`, `last_run`, `triggered_count`) for timers/cron and VM
  `status` for lxc/kvm.
- feat: **live service status in the UI.** A service resource's edit modal now
  shows a live "Status & metrics" card (active badge, CPU/mem/restarts/uptime,
  schedule or VM state) that re-renders on every `agent.telemetry` WebSocket
  frame, so the panel updates in near-real-time while open.
- feat: agent `register_service`/`unregister_service` frames are handled over
  the agent WebSocket and acknowledged with a response.

## v2.19.1
- fix: **the notification bell broke the nav bar.** The container holding username / bell / Log Out is `.form-inline`, a Bootstrap 4 class that does not exist in Bootstrap 5 — it laid out only because everything inside it happened to be an inline element. The bell is a `<div class="dropdown">` (Bootstrap requires that), so it forced a line break and pushed Log Out onto a third row. Replaced with `d-flex align-items-center`, which is what makes a row in Bootstrap 5 and does not depend on what the children are.

## v2.19.0
- feat: **notifications, with history and a bell.** Every model event you are allowed to see is a notification — the socket read gate already decides that, live and per row, so there is no recipient resolution and no fan-out: a notification is an event that reached you, and history is those same events replayed through the same gate. Clicking one opens the record that changed.
- feat: recording hooks into the one bus every gated event already flows through, ORM-managed or not, so nothing has to remember to log. It stores the **shape** only — model, action, pk, actor, owner, timestamp — with no payload, so history never becomes a second copy of the data retaining a deleted record's contents. Bounded by a 30-day TTL.
- feat: unread is one watermark per user rather than a read flag per item, so opening the bell on one device clears the badge on all of them.
- feat: collapsing is not cosmetic here — creating one resource emits eleven events (the resource, its groups, its edges), and a discovery sweep emits hundreds. The feed says "11 resource groups added"; history keeps every row.
- feat: `Notification` and `ApiToken` announce their writes via a small `withEvents()` wrapper. Deliberately not a Proxy over the class: that approach published the *class* name as the primary key for every model keyed on `name`, because a class always has a built-in `.name`.
- fix: `__NONE__` — the placeholder a record carries when it has been created but never updated — is treated as an absent actor rather than reported as the person who did it.
- chore: the notification client now comes from `@simpleworkjs/frontend` 0.4.0 rather than a copy in this repo; this app supplies only its link map.

## v2.18.0
- feat: **the Catalog and Discovered Inventory views update themselves.** Both read models that already published and already carried socket read gates — `AccessRequest` (owner-scoped: a directory admin sees all of them, everyone else only their own) and `Resource` (admin-scoped) — and neither view subscribed. The Catalog is one derived render (catalog, your access, your requests, pending approvals, drawn together), so a change re-runs the load rather than patching a tile that would then disagree with the others. The case that matters: an admin approves your request while the tile you are looking at still tells you that you cannot get in.
- note: `views/user_form.ejs` is deliberately not wired. It fetches resources once to prefill a location default; re-running that on a live event would overwrite what the operator has typed.

## v2.17.0
- feat: **the Network tab is live.** Sites, devices and exit grants update as they change. All three models already published and already carried socket read gates — the view simply never subscribed. Each list reloads its own fetch (they are derived views: peer counts, exit routing, per-site shape), debounced, since one device enrolment writes a client and a grant together. An exit grant refreshes the roster too, because that is what the roster's routing column shows.
- feat: **the Overview tab is live.** The notification history follows `Notification`; the stats card follows `User` and `Resource` rather than inventing a `Stats` record to publish — the aggregate is derived and the things it derives from already announce themselves. Each panel reloads only its own fetch.
- feat: **Redis-backed models can announce their own writes.** `Notification` and `ApiToken` are `model-redis` Tables with no custom mutators, so there was nothing to hand-edit; `model_events.withEvents()` wraps `create`/`update`/`remove` on the class. Deliberately not a Proxy over the class — that approach published the *class* name as the primary key for every model keyed on `name`, since a class always has a built-in `.name`.
- fix: `ApiToken` payloads carry no `secret_hash`. It is `isPrivate`, `model-redis` drops it in `toJSON`, and the emitter honours that — asserted against the serialized payload rather than the object, because `'k' in obj` is true even for an undefined value.
- note: the Overview metrics panel is **not** live. It reads failed-login and service-usage counters incremented outside any model write, so no model event corresponds to them; that panel needs its own emit where the counters change.
- chore: picks up `@simpleworkjs/frontend` 0.3.1 — filtered rows carrying a Bootstrap `d-flex`/`d-block`/`d-grid` class are now actually hidden, and the filter count no longer goes stale.

## v2.16.1
- security: **the agent pushes went to every authenticated socket.** `routes/api_agent.js` sent `agent.telemetry` (CPU/RAM/disk per host), `agent.discovery` (host inventory: open ports, services) and `agent.response` — **the output of commands run on a host** — with a bare `app.io.emit`, with no read check of any kind. The agent channel can run arbitrary bash, and its results were reaching every logged-in user regardless of whether they may see the host. Same defect as the model-event broadcast fixed in v2.14.0, on a channel that was missed because it does not carry model events; `directory.ejs` consumes two of these on a dedicated socket precisely to bypass the gated one, so the leak had a live consumer. They now go through `socket_pubsub.emitChannel`, applying the same per-socket check against the same admin groups the REST routes in that file already require. Channels are fail-closed like models: one with no gate is not delivered at all.

## v2.16.0
- feat: **model events are standardized, so storage backend no longer decides what can be live.** The ORM announced changes for models it managed; everything else was silent, which meant LDAP groups and users, Redis-backed notifications and PATs could not update a page no matter what the view did. `utils/model_events` gives them the identical contract — `model:<Name>:<action>` with `{model, action, pk, data}` — so a subscriber cannot tell which backend a model uses. `data` goes through `toJSON()` (stripping `isPrivate` fields), and a delete never carries a body, enforced in the emitter rather than trusted to each call site. ORM and bespoke models share one filtered bus, so "does this model have a read gate?" is answered in exactly one place.
- feat: **LDAP groups and users announce their changes.** `Group` covers add, remove and member/owner changes; `User` covers add, update and remove. The users and profile views consume them, so a user added or a group membership changed by another admin now shows up without a refresh — including on someone's own profile, where a stale page is most misleading since it is showing them their own access.
- security: read gates for every model whose data the UI renders — `ResourceEdge`, `Group`, `User`, `Notification`, `ApiToken`, `MeshClient`, `MeshSite`, `MeshExitGrant`, `AccessRequest`, `Agent`. Several are **row-level**, not merely model-level: a user receives their own `User` record, notifications, PATs and mesh clients and nobody else's, while a directory admin receives all of them except PATs — which have no admin path because the REST route has none either.
- security: `User` payloads strip `userPassword` explicitly. It **is** present on a record read with `attributes: ['*','+']` as the admin bind, and stayed off the wire only because `user_parse()` sets it to `undefined` inside an `if` branch — an incidental protection in an unrelated function, not somewhere to hang a credential.
- note: the `Group` gate mirrors its currently ungated REST route (`routes/group.js:8`) rather than being tightened past it. A socket stricter than the endpoint feeding the same page shows a list that silently stops updating; tighten the route and the gate follows automatically.

## v2.15.0
- feat: **the Directory and Discovery Plugins views update themselves.** A resource added, renamed or removed by another admin (or by a discovery plugin run) now appears without a refresh. The Directory table is derived — hierarchy from the edge list, hostName from the parent, agent status from another service, indentation and carets recomputed by `renderTable()` — so a change re-derives the view rather than patching one row, which would leave a new child at the wrong depth with no caret on its parent. `loadResources()` re-reads the search, sort and secrets-only controls, so the operator's filter survives. Debounced, since one edit emits several events and an import emits a burst.
- fix: **the socket never connected at all.** `authIO` called `Auth.checkToken(tok)` with a bare string where `{token}` is expected, then called `token.getUser()` — but `checkToken` returns the User itself and has no such method. Every handshake failed with `token.getUser is not a function`, so no client in this app has ever had a working socket.
- fix: **nothing published.** `@simpleworkjs/orm` has a `pubsub` hook that emits `model:<Name>:<action>` on save/delete, and it was never wired. It is now, through `utils/socket_pubsub.ormBus` — a filter that forwards only models with a socket read gate. The ORM publishes for everything it loads, including `AuthToken`, `OtpToken` and `PasswordResetToken`, written on every login and password reset; those must never reach a browser and would be constant bus churn besides.
- security: `READERS` is the single source of truth for what goes live. A model listed there both publishes (`LIVE_MODELS` is derived from it) and is authorized there, so the two cannot drift — publishing something ungated would leak, gating something that never publishes would be dead code. `Resource`, `ResourceGroup` and `PluginInstance` are gated to the same admin groups that guard their REST routes, resolved transitively from LDAP as `utils/permission.byGroup` does and cached briefly per socket.
- note: `views/plugins.ejs` is dead code — `/plugins` redirects to `/directory` and that UI was ported into `directory.ejs`. The Discovery Plugins subscription lives with the code that actually runs.

## v2.14.0
- security: **the socket bridge rebroadcast whatever a client published.** `socket.on('P2PSub')` took any topic and payload an authenticated client emitted and fanned it out to every other connected client. No app code has ever called `app.publish()`, so nothing legitimate used it. Events now flow server → client only.
- security: the outbound side was an unconditional `app.io.emit` of every event on the bus, with its full record, to every authenticated socket. Nothing here publishes model events yet, so it carried no traffic — but it would have started leaking the moment anything did. It is replaced by `utils/socket_pubsub.js`, a per-socket read gate whose `READERS` table is **empty by design**: nothing is broadcast until a model opts in together with the check that decides who may see its events.
- fix: a delete event carries a `null` body, and the client tagged it unconditionally — throwing and killing the socket handler.
- feat: the shared UI shell loads `app.sync.js` and `app.filter.js` from `@simpleworkjs/frontend`, so views here can adopt live updates and filtering.
- chore: `authIO` records the session's groups on the socket, which is what a read gate resolves rights from.

## v2.13.0

### Security
- **`PUT /api/mesh/self` is admin-gated.** It writes this site's WireGuard
  identity, exit posture and LAN/DNS mapping — previously any authenticated
  user could clobber the gateway public key (breaking every tunnel to this
  site cluster-wide), flip `exitOpen`, or remap DNS/LAN. The legitimate
  gateway authenticates with a PAT minted as the directory admin
  (bootstrap's `provisionJumpHost`), so `requireAdmin` lets it through while
  keeping everyone else out.
- **`GET /api/mesh/peers` and `/api/mesh/site-clients` are admin-gated.** Both
  expose the full network map (every site's keys/endpoints/AllowedIPs and the
  whole device registry with public keys + assigned IPs) and exist for the
  gateway to consume; a low-privilege user had no need of them.
- **`GET /api/mesh/roster` scrubs WireGuard keys/endpoints for non-admins.**
  The mesh page still shows site name, role, addresses and exit metadata, but
  no longer hands a regular user every site's dial endpoints (full network
  enumeration). Non-admins get a `gatewayPublished` boolean in place of the
  key; admins get the complete row.

### Fixed
- **The Multi-Site modal's gateway-mesh count no longer 404s.** It called
  `GET /api/mesh/gateways`, an endpoint that died with the mesh-v2 rewrite —
  the modal always reported "failed: HTTP 404". The count is now computed
  locally from the `MeshSite` roster (the directory IS the registry in v2),
  counting sites that have published a gateway key. `utils/jump_client.js`
  no longer needs a jump-host API token at all.
- **The LDIF import confirm is no longer a native `confirm()`.** `runImport`
  used the blocking browser `confirm()`; it now uses the app's promise-based
  `app.messages.confirm(...)` modal like every other destructive action.

### Other
- **Synced the served `theta-agent/install.sh`** (`nodejs/public/resources/
  theta-agent/install.sh`) with theta-agent v2.5.0: it now merges freshly
  supplied `--url`/`--token`/`--join-key`/`--public-key` into an existing
  `agent.yml` instead of dropping them, and picks the right Linux tray
  binary by arch.

## v2.12.0

The directory is now where the WireGuard cluster is configured. Sites, devices,
LAN mapping and internet exits all live here; each site's gateway reads the
roster and configures itself. Requires theta-gateway v3.0.0.

- feat: **the site network.** A site that joins the directory is on the network
  — no separate mesh to set up. `siteId` IS the site's `ldapServerId`, already
  allocated once cluster-wide by the master at join time (under a lock, after
  two spokes were once handed the same one), so the mesh needs no allocator of
  its own. That one number drives LDAP replication, the gateway's
  `172.24.0.<id>` address, and the site's `10.<id>.0.0/16`.
- feat: **`/network` page**, visible to any signed-in user because enrolling
  your own devices is not an admin task. Sites tab shows each site's addresses
  and whether its gateway has actually published a key — joined-but-not-started
  is a real state that used to look identical to healthy. Devices tab enrols
  hardware and picks an exit. Exit Access tab is admin-only.
- feat: **devices with optional key custody.** Supply a public key and the
  private half never reaches the server; omit it and one is generated, rendered
  into a config once, and forgotten — never stored, never logged, not
  recoverable. Addresses come from the site's own pool, lowest-free so a
  removed device returns its address rather than a counter marching upward.
- feat: **per-device internet exits.** Two independent things: a site marked
  `exitOpen` is saying it is *willing* to carry traffic; a grant says a user may
  use it. Revoking a grant immediately drops affected devices back to local
  breakout rather than leaving them routed somewhere they may no longer go.
  Exit choice is a routing rule on the gateway, so switching exits produces a
  byte-identical device config and needs no reconnect.
- feat: **DNS is pushed as the mapped address, not the physical one.** A device
  handed `192.168.1.1` only resolves while sitting on that LAN; over the tunnel
  what is routed is the shadow range. The site form shows the translation as
  you type and warns when an address is outside both mapped LANs, where it
  cannot be mapped and devices would get no resolver at all.
- feat: **MTU clamped to 1380** in device configs. Mesh-then-exit is WireGuard
  inside WireGuard, and a device sized for one hop blackholes large packets on
  the second — the classic "SSH works, HTTPS hangs".
- feat: devices running theta-agent are configured over the agent's existing
  websocket instead of a human copying a file. The push deliberately carries no
  private key: the agent holds its own.
- feat: the hub — the site carrying `10.0.0.0/8` as a catch-all — is chosen in
  the UI rather than implied by which site holds the master directory, since
  the natural hub is a cheap always-up VPS.
- change!: `utils/mesh_route.js` stops being a workaround. It existed because
  WireGuard lived inside the gateway container's namespace, so the only path to
  a peer was a userspace relay on a port derived from the site index. A peer
  site's directory is now simply `10.<siteId>.0.2:3001`, and the derived-port
  contract the two repos had to keep in sync is gone. An address in the retired
  scheme deliberately resolves to nothing rather than silently naming a
  different site. The public-endpoint fallback stays, so a deployment whose
  containers have no route into the mesh still replicates over the internet.
- fix: **the roster now reaches every site.** It is written at each site (a
  gateway publishes to its own directory) but replication only flows
  master -> spoke, so two halves were missing: a spoke's public key never left
  the spoke, and a spoke never learned any other site existed. Either alone
  means the mesh works only at whichever site happens to be the master. Spokes
  now forward their gateway details over `POST /api/site/spokes` — the channel
  they already have, with the credential they already hold — and the master
  carries the whole roster in its export. Roster edits push a resync
  immediately instead of waiting for an unrelated catalog change. A site's own
  row is never overwritten by an incoming export, since the local copy is
  always at least as fresh.
- fix: **exit interfaces need their own key.** A gateway's exit interface and
  its mesh interface presented the same public key to the same remote, which
  keeps one endpoint and one session per peer key — so the remote's endpoint
  flapped between the two and they invalidated each other's session. Verified
  against wireguard-go: with one key on two interfaces the remote settled on
  whichever handshook last while both kept re-handshaking; with separate keys
  it holds two stable peers. Gateways now publish a second `gatewayExitPublicKey`
  and `GET /api/mesh/peers` tells an exit site which gateways to accept under
  it, allowed only the device addresses actually using that exit.
- docs: [The Site Network](docs/network.md).

# v2.11.0 - 2026-08-11

### Added
- **Import users and groups from an existing LDAP directory.** New wizard at **Users → Import LDIF** (`/users/import`, admin-only) takes a `slapcat`/`ldapsearch` export and migrates accounts through the app's own model layer -- so every imported account arrives with a `UserVerification` row, a personal group, cache invalidation and service-account membership, exactly as if it had been created here. Two guarantees drive the design: `uidNumber`/`gidNumber` are preserved verbatim (they are what every file on every host is owned by -- reallocating them turns a migration into a filesystem-wide chown), and `userPassword` is carried across as the stored hash, never re-hashed, so people keep the password they already have. See [docs/ldif-import.md](docs/ldif-import.md).
  - `utils/ldif.js` -- a standalone RFC 2849 parser: line folding, base64, attribute options, CRLF. It refuses `attr:< url` values (a file-disclosure primitive handed to whoever uploads the dump) and rejects change records rather than misreading them as content.
  - `utils/ldif_import.js` -- schema-agnostic profiling, planning and applying. The layout of the source directory is *detected and then editable*, so a FreeIPA or AD export is a mapping change rather than a code change. Membership is resolved per entry, because real directories mix `groupOfNames`/`member` with `posixGroup`/`memberUid` and a single file-wide choice silently drops whichever kind loses.
  - Review happens before anything is written: every account shows what it will bring across, what it will not, and why it cannot be imported. Blocked rows (no `uidNumber`, a duplicate inside the file, a collision with an account already here) are skipped no matter what the client sends.
  - **Groups are never created by an import.** A group name from another directory carries no meaning in this one, where access is a projection of the resource graph (docs/groups.md). Each source group either has its members merged into a group that already exists, or is dropped; many-to-one is supported for collapsing a sprawling old directory.
  - Carried across where present: password hash, uid/gid numbers, name, email, phone, shell, home directory, description, location, date of birth, every SSH key, sudo rules, and the account's disabled state. Anything else is listed on the row as *not migrated* rather than dropped quietly.
  - Onboarding is a per-run choice (treat ToS as accepted / email as verified) so a cutover need not re-ask 30 people. Legacy MD5 passwords still always force a change at first login, and no welcome email is sent to anyone.
  - Staging lives in Redis under a one-hour expiry and is destroyed on apply or abandon; the parsed dump is never written to disk and password hashes are never included in an API response.

### Changed
- **`User.add(data, options)` takes an options argument** for `preserveIds`, `preserveHash` and `suppressWelcome`. These are a second argument rather than fields on `data` deliberately: every route calls `User.add(req.body)`, so a `uidNumber` honoured whenever present would let anyone who can create a user claim uid 0, and a `userPassword` that skipped hashing whenever it looked hashed would let them plant a known hash. Normal user creation is unchanged.
- **An account may share its primary group with another account.** Each account normally gets a personal group of its own, but nothing in POSIX requires that, and real directories do share -- the dump this was built against has two accounts whose primary gid is a third account's group. Under `preserveIds`, a group already holding the gid is referenced rather than duplicated.
- **`sudoHost`/`sudoCommand`/`sudoUser` are honoured when supplied.** New accounts still get this directory's `ALL`/`ALL` default; a migrated account keeps the rule it already had, rather than being silently granted more than the old directory gave it.
- `User.add` no longer runs its "email already in use" lookup when the account has no email address.

### Fixed
- **The docs allowlist gained `ldif-import`**, so the wizard's help link resolves in-app.

# v2.10.0 - 2026-08-11

### Added
- **`GET /install-agent/authorize`** — the theta-agent installer's "Log in to the Directory and get a join key..." button opens this page. A logged-in site admin gets a join key minted via `POST /api/agent/join-keys` and is redirected to the installer's loopback callback with `join_key` + `server_url`; unauthenticated users are sent through `/login?redirect=…` and return after logging in. The callback is validated to be loopback-only so a join key can't be steered to an attacker.

### Changed
- **Windows Install Agent command** on the Directory page now downloads the installer from this Directory (`/resources/theta-agent/theta-agent-windows-amd64-setup.exe`, staged by `setup.sh` at the matching suite version) instead of GitHub.

# v2.9.0 - 2026-08-11

### Fixed
- **The multi-site join's LDAP import had never worked.** Three stacked defects, each hidden because the only report was an `ldap.note` string no test asserted on: `ldapAddArgs()` omitted `argv[0]`, so the caller ran `execFile('-c', ...)` and every join/resync died with `spawn -c ENOENT`; raw `slapcat` output carries operational attributes (`structuralObjectClass`, `entryUUID`, `memberOf`, …) that `ldapadd` rejects outright; and `ldapadd -c` exits non-zero on the benign "Already exists" every spoke produces, so even a clean import reported failure. A spoke adopted the resource catalog and signing key but not one user or group. Fixed with `stripOperationalAttrs()` + `summarizeLdapAddResult()`; the e2e now seeds a master-only user and requires it to appear in the spoke's own slapd.
- **Catalog updates and deletions never reached a spoke.** `importDirectory()` called `Resource.update(id, data)` and `ResourceEdge.delete(id)` — statics `@simpleworkjs/orm` has never had (update/delete are instance methods). Both threw into a swallowing `catch`, so renames, metadata edits, edge removals and resource deletions were silently dropped; only *new* resources ever appeared. The injected test stubs implemented them as statics, which is why the suite stayed green. Stubs now mirror the real ORM shape, `tests/orm_method_guard.test.js` covers `update`/`delete` (and is now actually in `npm test` — it never ran in CI), and a contract test pins the stubs to the real base model.
- **`importDirectory()` is now converging rather than destructive.** It deleted every edge before recreating them, so a crash mid-import left a truncated graph. Creates land first, extras are removed afterward, and edge endpoints are remapped master-id → slug → local-id (a spoke's own bootstrap rows have local ids, and slugs like `openresty` are shared across sites, so raw ids pointed at rows that didn't exist). Resource deletions now propagate too, but only for rows this path adopted (`__replicatedFrom` provenance) — never a spoke's own locally-bootstrapped catalog.
- **Promotion orphaned every site beyond the second.** The promoted node was a spoke, so its own `SiteSpoke` registry was empty and `replicateToSpokes('master-promoted')` fanned out to nobody, while sibling spokes kept following the demoted master. `POST /api/site/demote` now hands its registry (including each spoke's `pushToken`) to the incoming master, which adopts it and re-points each sibling via the new `POST /api/site/master-changed`. Two-site clusters always worked, which is why this was invisible.
- **Concurrent spoke registrations were assigned the same LDAP ServerID.** `nextFreeLdapServerId()` + `SiteSpoke.create()` is a read-then-write; two simultaneous joins both read the same used-set and both got id 2. Duplicate ServerIDs don't fail loudly — they break MMR, since ServerID is how syncrepl tells originators apart. Serialized with a new `utils/mutex.js` — and, because that lock is process-local and would protect nothing if this app were ever run as two processes against one database, enforced for real by a unique index (see below).
- **`unique: true` on a model field never reached the database.** Two independent gaps: `@simpleworkjs/orm` only forwards `unique` for string fields (`IntegerField.toSequelize()` drops it), and the ORM calls `sequelize.sync()` with no options, which creates missing tables but never alters existing ones — so even `SiteSpoke.endpoint`'s long-declared constraint does not exist on any already-deployed site. `models/index.js`'s new `ensureUniqueIndexes()` adds the indexes explicitly, on the same add-only, fail-soft terms as the existing `healSchema()`. A database written before this can already hold duplicate ServerIDs, which would make `addIndex` fail, so `repairDuplicateServerIds()` runs first: the oldest registration keeps the id, the rest move to free ones (safe unattended — a spoke re-reads its ServerID from the master on every reconcile, and the duplicate state was already broken).
- **The mutex could deadlock silently.** Re-entering the same lock — directly, or by an outbound call that comes back into a route taking it — waited forever on a promise that could never settle, with the symptom surfacing somewhere else entirely (during promotion it appeared on the *calling* node as `re-point failed: This operation was aborted`, its own fetch timeout, while the callee sat waiting on itself). Same-context re-entry now throws immediately via `AsyncLocalStorage`; cross-node re-entry hits an acquisition timeout that names the current holder. `withLock` also no longer passes the previous holder's resolution value into the next callback, and drops its bookkeeping entry once a lock is idle so data-derived lock names cannot leak.
- **A base-DN mismatch between sites now fails the join up front.** `CFG_DOMAIN` must be identical cluster-wide (MMR replicas cannot diverge on base DN), but a mismatch used to half-succeed: catalog and signing key adopted, LDAP silently rejected entry-by-entry with "no global superior knowledge".
- **The mesh carried no service traffic.** Consumers dialled `172.24.<idx>.1:3001` directly — an address that exists only inside the peer gateway's network namespace, unreachable from the `sso-manager`/`theta-proxy` containers told to use it, with nothing listening on `:3001` there anyway. No-inbound relay routes and mesh-preferred resync pushes both resolved to a dead target. `utils/mesh_route.js` now routes via the LOCAL gateway's per-peer forwarding port, derived from the mesh index (see `theta-gateway`'s `services/mesh_forwarder.js`).
- **LDAP tunnel relay sockets were unbounded.** No idle timeout, no connect deadline, no per-agent ceiling, so an agent that vanished without a clean close stranded its relay sockets indefinitely; and `cleanup(agentId)` tore down a *reconnecting* agent's new sockets along with the old ones. Now bounded on all three axes and scoped per WebSocket.
- **The Multi-Site modal's confirmations did nothing.** `app.messages.confirm()` renders into a `.actionMessage` element and its promise never settles without one — the modal had none, so both the spoke-remove and the pre-existing promote confirmation silently no-op'd on click. Added the region; per-row removal uses an inline row-scoped confirm instead (a single shared banner desyncs across rows).

### Added
- **LDAP replication config is applied live — no `setup.sh` re-run, on any node.** `slapd` now runs from the `cn=config` dynamic backend (converted at container start from the generated `slapd.conf` seed), so `olcServerID`/`olcSyncrepl` are modifiable while it serves. `utils/ldap_runtime_config.js` converges the running config on the cluster's view (read, diff, apply only what differs); `utils/ldap_reconcile.js` triggers it on spoke registration/removal, join, resync, master-changed, promotion, boot, and a periodic sweep. Previously every site's peer list went stale each time any site joined, fixable only by an operator re-running `setup.sh` everywhere. Drift detection is retained as a fault indicator.
- **Registered Spokes is actionable**: `DELETE /api/site/spokes/:id`, `POST /api/site/spokes/resync` (awaited, so "Sync now" reports real reachability), and `GET /api/site/spokes`.
- **`POST /api/site/reregister`** — the recovery path when a spoke and its master disagree about the push token (a removed/recreated registry row, or a join made without `selfUrl`). `POST /join` cannot fix it: it refuses once a node is a spoke.
- Three-site e2e (`docker-compose.multisite-e2e.yml`) covering the promotion handoff, live LDAP replication config, LDAP tree replication, and resource update/delete convergence — all previously uncovered.

# v2.8.0 - 2026-08-11

### Fixed
- **Promotion no longer orphans the demoted old master's LDAP replication.** Neither `/site-promote` nor `/demote` touched `SiteSpoke` -- the demoted old master got a fresh join key but no `SiteSpoke` entry on the new master (no `ldapServerId`, invisible to the peer list), and structurally could never self-heal via `/join` (refuses re-join for a node that's already a spoke). `/demote` now registers itself with the new master immediately, deriving its own endpoint from `stack.selfUrl`/`stack.ssoHost`. `/site-promote`'s response also now surfaces that the promoted node's own OpenLDAP ServerID needs a `setup.sh` re-run to actually apply.
- **The Directory's site slug and the multi-site replication identity are unified.** These were two unrelated values that happened to share a name -- a deployment could show a real site name in the Directory catalog and the literal `site-default` fallback on the Multi-Site modal for the same node. `POST /resources` now syncs `site_config`'s `siteSlug` to match the moment this node's own site Resource is first created, for a still-default master only.

### Added
- **LDAP replication status + per-spoke detail on the Multi-Site modal.** New `utils/ldap_replication.js`'s `currentSlapdServerId()` reads the actual running ServerID from this node's own `slapd.conf` -- distinct from what the API currently advertises, which can genuinely disagree right after a promotion or a new spoke joining. `GET /directory-admin/site-status` now surfaces both plus a `stale` flag and a full spokes list (endpoint, assigned `ldapServerId`, relay path), not just an aggregate count.

# v2.7.0 - 2026-08-11

### Added
- **OpenLDAP N-way multi-master replication auto-config.** `SiteSpoke.ldapServerId` is now auto-assigned at registration (next free from 2 upward, 1 reserved for the master -- same pattern as jump-host's mesh index), and each site's LDAP URL is derived from its already-known HTTP(S) endpoint rather than a separately-configured field. New `utils/ldap_replication.js`, `GET /api/site/ldap-peers` (spoke-facing, Bearer site join key) and `GET /directory-admin/ldap-replication-config` (master-local). Operators no longer hand-maintain `LDAP_SERVER_ID`/`LDAP_REPLICATION_HOSTS` for a `theta-suite`-joined cluster (see `theta-suite`'s `bootstrap/site-ldap-register.js`). Verified against real running containers (`docker-compose.multisite-e2e.yml`).

# v2.6.0 - 2026-08-11

### Fixed
- **Duplicate access/admin groups on repeated resource promotion.** Three independent copies of the same bug (`routes/discovery.js`'s `POST /discovery/promote/:slug` -- the actual "Promote" button in the UI -- and `services/discovery_reconciler.js`'s `autoPromote` path both called `ResourceGroup.create()` directly with no existence check, unlike `routes/api_directory_admin.js`'s own `ensureResourceGroup`, which already carried a comment describing this exact bug). A resource promoted more than once (a retried click, or the same LXC discovered from multiple Proxmox cluster nodes) silently accumulated duplicate rows every time. Consolidated into `ResourceGroup.ensure()` on the model, used everywhere.
- **`GET /api/directory-admin/resources` ran a full LDAP group self-heal fan-out on every single list** (`ensureSiteGroups` per site + `provisionResourceGroups` per resource, each several sequential LDAP round-trips), unconditionally -- confirmed as the actual bottleneck once a directory has more than a handful of resources, not data volume. Moved healing to where resources actually change instead (`POST`/`PUT /resources`, `POST /discovery/promote/:slug` -- `PUT` had none at all before this), and added `POST /resources/heal-groups` as an explicit on-demand equivalent for backfilling a directory seeded before this change.
- **An nmap discovery scan that completed successfully could be reported as a failed run with zero hosts found.** `node-nmap` (the vendored library) treats any stderr output from the nmap binary as fatal -- including nmap's own harmless RTT-calibration warning ("RTTVAR has grown to over N seconds..."), which it prints *during* a scan that goes on to complete normally, discarding valid results already sitting in the library's `rawData`. Our plugin now recognizes this specific benign message and manually completes the scan from the data that's already there; any other error still rejects as before.
- **The Multi-Site modal's "Theta Gateways" count was measuring the wrong subsystem.** It counted this app's own unrelated WireGuard roaming-client/exit-node Resources, not jump-host's actual gateway-to-gateway mesh registry. New `utils/jump_client.js` (same self-service-token pattern as `utils/proxy_client.js`) queries jump-host's real `GET /api/mesh/gateways`, reporting a distinct "unknown" state instead of a misleading 0 when the integration isn't configured. Also added help links to the published multi-site/mesh docs on the modal.

# v2.5.0 - 2026-08-10

### Added
- **No-inbound relay automation.** A spoke with no public IP of its own can now register as such (`noInbound`/`meshIp`/`publicHost` on `POST /api/site/spokes`, forwarded through `POST /api/site/join` for the real operator join flow), and the master auto-creates/updates the relay route on its own `theta-proxy` via `utils/proxy_client.js` — a new self-service `prx_...` API token client, reusing `theta-proxy`'s existing token system rather than inventing a new credential type. Verified against a real running `theta-proxy` container (`GET /api/host/:item`'s actual `{item, results: {...}}` response shape, not the flat shape first assumed).
- **Replication traffic prefers the mesh.** `utils/site_replicate.js`'s fire-and-forget resync push now tries a registered spoke's `meshIp` first (falling back to its public `endpoint` on failure) — cross-component routing over the gateway-to-gateway WireGuard mesh instead of the open internet, for any spoke that's registered one.
- `POST /api/site/join` surfaces the resulting relay status in its response (`relay.note`), and `theta-suite`'s bootstrap flow (`CFG_SPOKE_NO_INBOUND`/`CFG_SPOKE_PUBLIC_HOST`, `bootstrap/site-relay-register.js`) drives all of this from the real operator-facing setup script, not just the API.

# v2.4.0 - 2026-08-10

### Added
- **Live catalog replication.** A spoke now stays in sync after joining instead of only getting a one-time snapshot: it registers its own endpoint with the master at join time (`POST /api/site/spokes`, Bearer the site join key), and every successful master catalog write fires a fire-and-forget push (`utils/site_replicate.js`) at every registered spoke, concurrently — one unreachable spoke never blocks or delays delivery to another. The spoke's `POST /api/site/resync` handler re-runs the same tested export-pull-and-import path used at join time rather than applying a partial diff.
- **Identical-directory agent-signing key.** `POST /api/site/export` now best-effort includes the master's agent-signing key; a spoke adopts it via `agent_keys.adopt()` on both join and every resync, so any site's `sso-manager-node` can validly sign a command for any agent enrolled at any other site (a deliberate blast-radius tradeoff for this deployment's small, trusted scale — see `theta-suite`'s `docs/MULTI_SITE_SPEC.md` §2).
- **Coordinated master promotion.** `POST /api/directory-admin/site-promote` now demotes the previous master as part of the same action (mints it a fresh join key, calls its new `POST /api/site/demote`) instead of leaving a manual two-step gap where two nodes could both believe they're master. Best-effort: an unreachable old master (the WAN-outage scenario this control exists for) never blocks the local promotion — the response's `handoff` field reports what happened.
- **Master Site modal UI**: new "Live Replication" (spoke) / "Registered Spokes" (master) status rows; the join form gained a "this site's own reachable URL" field (prefilled from the browser origin) wired to the `selfUrl` the join API already supported but the UI never sent — a UI-driven join previously never registered for live replication, only the `setup.sh` bootstrap path did; the promote button's success toast now reports the actual handoff result.
- New `nodejs/models/site_spoke.js` (registered spokes + their push tokens) and `docker-compose.multisite-e2e.yml` + `test/multisite_join_e2e.js` (real two-container master+spoke regression test covering join, live replication, promotion, and demotion end to end).

### Fixed
- **`site-promote`'s god_admin check was dead on arrival.** It read `req.user.groups`, a field nothing in the codebase ever populates (every other admin gate resolves membership live via `permission.byGroup()`/`Group.list(user.dn)`, which also handles nested-group membership) — the check silently evaluated to an empty array on every request, so promotion returned 403 for every user, including a real god_admin, since it shipped in v2.0.0. Only surfaced by the live e2e test, not by inspection.
- **The read-only write-gate blocked `site-promote` on a spoke before its handler could run** — the one mutating request a spoke must be able to make to itself. Exempted `/site-promote` from the gate.
- **`GET /api/site/config` was returning `masterJoinKey` and `replicationPushToken`** — live credentials — directly in the JSON response to any admin session. Replaced with boolean derivatives (`hasMasterJoinKey`, `liveReplication`).

# v2.3.0 - 2026-08-10

### Added
- **Multi-site join — UI + enforcement** (completes the join layer started in v2.2.0):
  - **Master Site modal**: a fresh install (no users beyond the bootstrap admin, no agents) gets a **"Join an Existing Site"** form (master URL + site join key); a master gets a **Site Join Keys** manager (mint/revoke/list, key shown once, copy button); **WAN Sync Health** now reflects a live probe of the master.
  - `POST /api/site/ping` (Bearer site-join-key): lightweight master reachability probe for WAN health.
  - **Spoke read-only**: directory-write routes (resources, edges, groups, secrets, grants, driver actions, discovery merges) return `403` pointing at the master once a node is a spoke.
  - **Fresh-install guard**: `/api/site/join` refuses unless the directory has no users beyond the admin and no enrolled agents (`siteIsFresh`); `site-status` exposes `canJoin` so the UI only offers join when it's actually allowed.
  - The spoke persists the join key (`masterJoinKey`) in `/config/site.json` for WAN health + future write-proxy.
- **Unit tests**: `siteIsFresh` cases (admin-only, second user, enrolled agent, service accounts ignored).

### Fixed
- **Branch-protection check name**: the lint job that `master` requires is literally named "Syntax check bootstrap.js"; the multi-site bootstrap script is checked by that same job.

# v2.2.0 - 2026-08-10

### Added
- **Multi-site join — server endpoints.** A spoke can join an existing master directory:
  - **Site join keys** (`stj_…`): mint/revoke/delete under `/api/site/join-keys` (hashed at rest, shown once — same model as agent join keys).
  - `POST /api/site/export` (master, Bearer site-join-key, no admin session): returns the LDAP tree (`slapcat` LDIF) + resource catalog + siteSlug + baseDn.
  - `POST /api/site/join` (spoke, admin): `{ masterUrl, joinKey }` pulls the master export, imports resources (upsert by slug) + LDAP (`ldapadd -c`), and persists the spoke role. Refused if already a spoke.
  - **Persisted site role**: `isMaster`/`masterUrl`/`siteSlug` now live in `/config/site.json` (env seeds defaults) instead of Node memory, so a restart no longer silently reverts a spoke to master. `site-status`/`site-promote` read/write it.
  - Docs: `docs/site-join.md` (flow, endpoints, planned `setup.env` vars) registered in the docs router.
  - The UI + `setup.sh` wiring for join is the next layer; this pass is server-only.
- **Unit tests** for the join helpers (`tests/site_join.test.js`) and persisted config (`tests/site_config.test.js`) — pure logic, in-memory stubs, added to `npm test`.

### Fixed
- **Multi-site modal text was mojibake.** The Master/Spoke emojis (👑/⚡) in `views/directory.ejs` were UTF-8 that had been round-tripped through cp1252; restored. All other views verified byte-accurate clean.

# v2.1.1 - 2026-08-10

### Fixed
- **"Master Site" button errored with `app.modal.show is not a function`.** The multi-site status modal used the legacy `app.modal.show()` signature; the app exposes `app.modal.open({ title, bodyHtml, size })`. The site-status request itself worked — only the rendering call was wrong.
- **Agents with no discovery yet showed a fake `v2.0.0`.** Three hardcoded fallbacks now report `unknown` instead, so a host whose agent hasn't connected isn't presented as an old version.

# v2.1.0 - 2026-08-10

### Added
- **Windows install commands in the Install Agent modal.** The Directory → Install Agent modal now emits PowerShell one-liners alongside the bash ones for the join-key, pre-register, and custom-config flows. Each downloads the fully-offline theta-agent `setup.exe` from its GitHub release and passes the same values the bash flow uses (`/SERVER_URL`, `/JOIN_KEY`, `/AUTH_TOKEN`, `/PUBLIC_KEY`, or `/B64_CONFIG`), so a Windows host enrolls with the same one-command flow as Linux. Complements the theta-agent v2.1.0 Windows release.

### Removed
- **Large binaries from `nodejs/public/resources/theta-agent/`.** The agent/tray/helper/setup binaries are now built on GitHub Actions and attached to the theta-agent GitHub release as artifacts; `install.sh` and the modal download them from `releases/latest/download/`. Nothing binary lives in this repo anymore (the small `install.sh` bootstrap script remains).

# v2.0.4 - 2026-08-09

### Changed
- **`Dockerfile.openldap` no longer compiles OpenLDAP from source.** Its `ldapbuild` stage now pulls `ghcr.io/theta42/openldap-nestgroup:<pinned commit>` (built once by `.github/workflows/build-openldap-image.yml` from the new `Dockerfile.openldap-builder`) instead of cloning `git.openldap.org` and running `./configure && make` on every build. Cuts ~5 minutes off every build of this Dockerfile, including 3x per CI run's test matrix, and removes the runtime dependency on that mirror being up (it 502'd twice tonight, blocking two PRs). Verified locally end-to-end before merging: built the app image against the published base, ran it, confirmed slapd boots healthy with the nestgroup overlay loaded and the correct pinned commit.

# v2.0.3 - 2026-08-09

### Fixed
- **Directory tab showed unpromoted discoveries.** `GET /api/directory-admin/resources` unconditionally admitted every `kind: 'host'` resource, and every discovery plugin (UniFi, Proxmox, nmap) creates its finds as `kind: 'host'` — so unchecking "Auto-promote to Directory" on a plugin never actually kept undiscovered/unpromoted devices out of the Directory tab, only out of the LDAP-group auto-provisioning. Now only `site` resources are unconditionally shown; anything else that discovery ever touched requires `metadata.managed === true` (set by promotion, an agent, or merging into an already-managed resource).
- **`GET /api/directory-admin/site-status` 500'd.** Queried `Resource.list({ where: { subType: 'wireguard' } })`, but `subType` only ever lives in `metadata.subType` (every driver/discovery plugin reads it that way) — never a top-level DB column, so SQLite raised `no such column: Resource.subType`. Filters in JS over `metadata.subType` now.
- **Discovered Inventory had no way to review ignored devices.** Added a "Show ignored" toggle (off by default) to the tab, so `metadata.ignored === true` rows stay hidden from routine triage but remain reachable.

### Chore
- **Untracked `nodejs/config/inventory.sqlite`.** It's the app's default runtime DB (`nodejs/models/index.js` falls back to this path when no external DB is configured), not a fixture — it had been committed by mistake across 13 prior releases, churning on every local run. Removed from tracking and gitignored.

# v2.0.2 - 2026-08-09

### Fixed
- **README rebranding & standalone-install cleanup.** Removed the "Why this over the alternatives" section and stale links to the old per-repo GitHub Pages site (`theta42.github.io/sso-manager-node/`); documentation and secrets links now point at the unified `theta42.github.io/theta-suite/` site. Made explicit that Theta Directory is deployed as part of Theta Suite and isn't installed or run on its own. Added the agent capability/install screenshots to the gallery.

# v2.0.1 - 2026-08-09

### Fixed
- **OpenBao / OpenBoa Container Exclusion**: Skip discovery of internal secret management/renewer containers so they don't populate resources catalog.
- **Agent Version API Collection**: Added `version` tracking to Agent model and discovery handlers to record and report agent version dynamically.
- **Console Log Cleanup**: Removed leftover `console.log` debug statements in frontend assets.
- **Resource Save & User Cache Invalidation**: Fixed metadata merge on resource updates to prevent losing system fields, and added User cache clear to propagate user/group edits instantly.
- **Site Status 500 Fix**: Replaced invalid ORM `Resource.findAll()` call with `Resource.list()`.
- **Secret Filtering**: Fixed the "With Secrets" filter checkbox by ensuring `hasSecret` / `secretKeys` states are written to resource metadata and checked by EJS views.
- **Auto-Group Spawning Prevention**: Set default `autoPromote` to false in UniFi, Docker, Proxmox, and Nmap plugins and restricted auto group creation to managed resources to prevent duplicate LDAP group generation.

# v2.0.0 - 2026-08-09

### Added
- **Multi-Site Master Architecture.** Multi-Site Master badge, `/api/directory-admin/site-status` API, and Master site promotion UI.
- **Full Telemetry Dashboard Cards.** Rendered active `logged_users`, physical partitions, host details, and desktop session/power controls (Lock, Display Off, Log Out, Sleep Host).
- **Theta Directory Rebranding.** Rebranded SSO Manager UI and documentation to Theta Directory.

### Fixed
- **Agent Action Parameter Resolution.** Standardized top-level and nested parameter parsing for agent driver actions (`api_directory_admin.js`).

# v1.33.0 - 2026-08-08

### Added
- **Directory Key Badges & Secret Filtering.** Added a gold `🔑 Secret` badge next to resources with stored OpenBao secrets and a `With Secrets` filter checkbox to filter the directory tree by secret presence.
- **Kind-Specific Resource Creation Modals.** Added dedicated `openAddSiteModal()`, `openAddHostModal()`, and `openAddServiceModal()` modal handlers for Site, Host, and Service resources.
- **Top Toolbar Reorganization.** Updated top tree button to **"+ Add Site"** and removed legacy `Plumbing` slider.
- **Optional Child Secret Key Name on Inheritance.** Made key name optional when inheriting parent secrets — automatically defaulting to the original parent secret key name if left blank.
- **Discovered Inventory Merge & Ignore Actions.** Added `Merge` (merge IP/interfaces/OS metadata into target resource) and `Ignore` (dismiss discovered item) endpoints (`/api/directory-admin/discovered/merge` & `/api/directory-admin/discovered/ignore`) and table action buttons.
- **Agent Tab Telemetry & Desktop Controls.** Rendered Agent Binary Version badge (`v1.8.0`), all physical disks and filesystems table, Active Logged-in Users card, and Desktop Session & Power Operations card (Lock, Display Off, Log Out, Sleep Host).

# v1.32.0 - 2026-08-08

### Added
- **Subtype Management & Metrics Drivers Engine.** Built a 4-tier driver resolution engine (`services/driver_registry.js`) binding resource `subType` metadata (`systemd`, `docker`, `proxmox`, `wireguard`, `postgresql`, `redis`, `unifi`, `k8s`) to operational telemetry, log streaming, and remote lifecycle control.
- **Subtype Operations APIs.** Exposed `/api/directory-admin/resources/:id/driver-metrics`, `driver-action`, and `driver-logs` endpoints.
- **Explicit Secret Inheritance Mode.** Enforced strict upward ancestor lineage (`Resource -> Host -> Cluster -> Site`) for secret inheritance, resolving explicit pointers (`INHERIT:<parentSlug>:<parentKey>`) without exposing sibling directory secrets.
- **Consolidated External App Tokens.** Relocated external OpenBao App Token minting into the **Configuration** page (`/conf` -> External App Tokens tab) and deprecated standalone `/vault` navigation item.
- **Multi-Secret Key Support.** Supported multiple secret keys per resource in OpenBao `secret/data/resources/<slug>/conf` with per-key merging and deletion.
- **Cross-Platform Agent Packaging.** Built multi-architecture Dockerfile staging and documentation for Linux ARM (arm64, armv7), Windows (amd64, arm64), and macOS (Intel, Apple Silicon).

### Fixed
- **Ancestry Lineage Querying.** Fixed `Resource.findAllAncestors(id)` memory filtering over `ResourceEdge.list()` to resolve deep ancestor lineage across all graph depths.
- **Dockerfile Module Inclusion.** Included `COPY nodejs/drivers ./drivers` in `Dockerfile.openldap` and `Dockerfile.test-runner` for clean container execution.

# v1.31.0 - 2026-08-07

### Added
- **Resource Secrets Engine & Zero-View Security.** OpenBao KV-v2 encrypted secrets for directory resources (`secret/data/resources/<slug>/conf`). Zero-View UI & API model — secret values are never returned to admin browsers or UI templates, and delivered exclusively to authenticated `theta-agent` instances.
- **Strict Secret Key Regex Validation.** Secret keys are validated against `^[A-Za-z0-9_]+$` (Standard Environment Variable format, e.g. `DB_PASSWORD`).
- **Field-Populating Password Generator.** Cryptographic secret generator (`window.crypto.getRandomValues`) with length selector dropdown (8–128 chars) populating input fields with security notices.
- **Multi-Level Secret Inheritance.** Dynamic secret resolution across any depth of the resource tree (`Services / Apps -> Hosts / Nodes -> Global Sites`).
- **Non-Blocking UI Confirmations.** Replaced browser blocking dialogs with async `app.messages.confirm()` banners.
- **UI Directory Layout Improvements.** Fixed Directory table resource name and badge order for enhanced readability.

### Fixed
- **SSSD `sshPublicKey` Mapping.** Included `ldap_user_ssh_public_key = sshPublicKey` in generated agent `sssd.conf` template.

# Unreleased — LDAP-over-HTTPS API + agent LDAP byte-pump relay

### Added

- **`POST /api/v1/ldap/bind` and `POST /api/v1/ldap/search`** — an LDAP-over-HTTPS
  API (DESIGN.md §3). A client stops speaking LDAP and instead does an HTTPS call
  to the SSO, which performs the real bind/search against its own OpenLDAP. This
  kills the hostname / cross-network / LDAPS-cert-chain pain. Caller auth is a
  Bearer token: an agent token or a self-service API token (PAT). `/search` is
  restricted to agent callers (the SSSD user/group-resolution use case) and runs
  under the admin bind — see DESIGN.md §9.5 for the scoped-service-account
  follow-up.
- **LDAP byte-pump relay** (`utils/ldap_tunnel.js`) — the SSO relays raw LDAP
  bytes from an agent's local socket into its real OpenLDAP and pipes the
  response back, over the existing agent WSS channel (`ldap_tunnel` messages).
  The SSO does not parse LDAP; it is a transparent socket relay. See DESIGN.md §4.
- **`POST /api/v1/agent/secrets`** — an agent fetches its own node-scoped OpenBao
  secrets (DESIGN.md §5). The agent may only read under `secret/data/nodes/<id>/*`;
  the SSO fetches with its own OpenBao access, so the agent never holds a Vault
  token. Agent-token authed (not admin-gated).
- **`iam_apply` command** — the SSO pushes node-scoped IAM config (sudo rules,
  SSH keys, access control, revocation) to an agent as a signed high-risk
  command (DESIGN.md §6). Added to `HIGH_RISK_COMMANDS`.
- **Agent capabilities in the Directory UI** — the agent reports its enabled
  capabilities in its `discovery` frame; the SSO stores them and the host's
  Metrics tab renders them as green/gray badges, so an operator can see at a
  glance what each agent is allowed to do.
- **`GET /api/agent/join-keys/:id/agents`** — which hosts enrolled through a
  given join key. Matches on the trace `Agent.enroll` already leaves in
  `description` ("Self-enrolled with join key `<prefix>`") rather than a stored
  relation.
- **Join key management in the Install Agent modal** — a table (label, prefix,
  created date, hosts joined, status) alongside the existing mint/select
  dropdown, with **Revoke** and **Delete** actions and a click-through to see
  which hosts joined via a given key. Previously these were API-only. Revoke
  and Delete confirm inline within the row ("Revoke? Yes/No") rather than a
  blocking native `confirm()` (freezes the whole tab) or the shared
  `app.messages.confirm()` banner (a single `.actionMessage` shared by the
  whole card, so a second click before the first resolves leaves a dangling
  `$('body').one('click', ...)` handler from the first call and desyncs which
  row the banner is actually confirming for).

# v1.30.2

### Fixed

- **Outbound mail (test email, invites, password resets, OTP-by-email, notifications) could be rejected by the SMTP relay with `554 5.7.1 ... Sender is not same as SMTP authenticate username`.** Many authenticated relays require the `From` address to match the authenticated account or they refuse the send outright. `models/email.js` fell back to a hardcoded `noreply@theta42.com` when `smtp.from` wasn't set, which no relay ever authorized this account to send as. It now falls back to `smtp.user` first — the address the account can actually prove it owns — before the hardcoded placeholder.
- **Catalog page card titles read icon-then-name.** Swapped to name-then-icon so the resource name leads.

### Docs

- `docs/configuration.md` didn't mention that OpenBao + the live Configuration UI sit above the four file/env config layers and win the merge — added.
- `docs/plugins.md` listed 3 of 4 discovery plugin types (missing `docker`) and didn't mention the `messaging` plugin category (`twilio`, `webhook`) at all — added both.
- `docs/vault.md` had no navigation (no frontmatter, no back-link, unreachable from the docs index) and described OpenBao as running in dev mode with API access via the root token — both wrong for a real deployment. Fixed navigation and corrected to describe the actual production setup (unsealed OpenBao, server-side scoped-token injection, personal API tokens for programmatic access).
- `docs/discovery.md` was unreachable from the docs index and missing its back-link — both fixed.
- `README.md`'s required-groups list was missing `app_sso_directory_admin` (gates Directory/Plugins/Agent admin).

# v1.30.1

### Fixed

- **Test Email always failed with `Email.send is not a function`.** `models/email.js` exports `{Mail}`; the handler required the module and called `.send` on it directly. Every other caller destructures it. The button could never have worked.
- **Test SMS failed with `Unexpected token '<', "<!DOCTYPE "...`.** It POSTed to `https://api.voip.ms/v1.0/sms/send` with Basic auth — an endpoint that does not exist. VoIP.ms's REST API is a GET against `https://voip.ms/api/v1/rest.php` with `api_username`/`api_password` and `method=sendSMS`, so the fabricated URL returned an HTML page and `response.json()` threw. It could never have sent anything.
- **All SMS delivery was broken, not just the test button.** `models/sms.js` called `PluginInstance.find({…})`, but @simpleworkjs/orm has no `find` — the query method is `list({where})`. It threw "is not a function" on every send, before it could even fall back to the direct VoIP.ms path, so OTP-by-SMS and notifications were dead too.
- Both test endpoints now send through the **same senders every real message uses** (`Mail.send`, `SMS.send`). A test that reimplements delivery proves nothing about whether real delivery works — which is exactly how two broken paths went unnoticed.
- The SMS credential check no longer demands `conf.voipms` when a messaging plugin is loaded; the plugin supplies its own credentials, and requiring both blocked a working setup from testing itself.
- Both endpoints report a failure as a `400` with the underlying reason (`VoIP.ms error: invalid_credentials`, `connect ECONNREFUSED …:587`) instead of an opaque `500`. A misconfiguration is the operator's to fix and the UI should be able to show it.
- test: a guard suite that fails the build on any call to a non-existent ORM static (`find`/`findOne`/`findAll`/`where`), on requiring `models/email` without destructuring `{Mail}`, and on any reference to the bogus `api.voip.ms` host.

### Added

- **Install Agent offers the join-key flow.** The modal now leads with "Join key" — mint one, copy a single install command, and the host enrolls itself. Pre-registering a specific host moved to a second tab. v1.30.0 shipped join keys in the API and documented the modal as the place to get one, but the modal itself still only did the pre-register flow.

# v1.30.0

Adds **join keys**: installing the agent with one key is now all it takes to add a host. Fixes a set of Directory/discovery defects found on a fresh `setup.sh` install.

### theta-agent — enrollment without pre-registering

- feat: **join keys.** `POST /api/agent/join-keys` mints one credential an operator hands out. A host presenting it is enrolled automatically and immediately issued **its own** per-agent token plus the public key it must pin, delivered in the `config` frame; the agent persists both and blanks the join key. v1.29.0 required an admin to pre-register every machine before its agent would be spoken to, which made adding a host a two-system chore — the security model was right, the workflow was not.
- feat: a join key is a bootstrap credential, never the host's identity, so one key stays convenient without becoming a fleet-wide skeleton key: every host remains individually revocable and a compromised host yields nothing that works elsewhere. Revoking a join key stops new hosts joining and leaves already-enrolled agents alone.
- feat: join keys support a label and optional expiry, record their use count, and are stored as a SHA-256 (`AgentJoinKey`). Issue/revoke/delete and every self-enrollment are audited.

### Directory

- fix: **collapsing the tree did nothing.** `applyTreeCollapse` located the caret with `$row.find('.tree-caret i')` and returned early when it found nothing. Font Awesome runs in SVG-with-JS mode and its mutation observer rewrites every `<i class="fa-…">` into an `<svg>`, so moments after a render that selector matched nothing — and the early return skipped setting `hideBelowDepth`, so no row was ever hidden. Collapse state now lives on the caret *button* and is rotated by CSS, and the hide decision is made from the collapsed set alone. Never key behaviour to an element another library is free to replace.
- fix: **the Discovery Plugins delete button did nothing.** It called `deleteDiscoveryPlugin()`, which was never defined — clicking it only threw a `ReferenceError`.
- fix: the plugins pane had no `.actionMessage` element, and `app.messages` confirmations render into one. Without it the returned promise **never settles**, so an awaited confirmation hangs forever and the action it gates silently never happens. Added, along with a note that any pane asking for confirmation needs it.
- feat: **discovery plugin instances can be edited.** Name, schedule, loaded state and configuration, with secrets on their own endpoint and left blank ("unchanged") rather than prefilled with the mask — submitting `********` back would otherwise store the asterisks as the secret.

### Discovery

- fix: **a fresh install no longer presents its own containers as things to triage.** The Docker plugin recognises containers belonging to the stack's own compose project, records them as managed, and attaches each to the service it implements. `setup.sh` deploys `sso-manager`, `proxy`, `jump-host`, `openbao` and `bao-renewer`; all five arrived as unmanaged discoveries awaiting promotion.
- fix: **Docker container slugs were derived from the container id**, which changes on every recreate — so each `docker compose up` minted a brand-new resource and orphaned the previous one. Slugs now come from compose project + service, falling back to the container name.
- feat: discovered containers carry `composeProject`, `composeService`, `containerName` and `sourceId`.

### Docs

- fix: `/docs/discovery` 404'd — the slug had no entry, though the Discovery tab's help icon linked to it. New `docs/discovery.md` covering the catalog/discovered distinction, how sources are matched and merged, naming precedence, promotion and garbage collection.
- fix: the `agents` slug pointed at `plugins.md`, so `docs/agents.md` was unreachable in the app.

# v1.29.0

**Breaking:** theta-agent enrollment is now mandatory. Agents installed before this release carry a browser-generated token the server never recorded and will be rejected until re-enrolled. Requires theta-suite ≥ v1.42.0 (the `sso-broker` OpenBao policy must grant `secret/agent/*`); re-run `./setup.sh`.

### Security — theta-agent channel

- **sec: `/api/agent/ws` accepted any token.** There was no agent registry, so the endpoint authenticated nothing: any client that could reach the SSO could register as a node, publish discovery/telemetry into the admin view, and receive commands — including a signed `arbitrary_bash` — addressed to a token it guessed. Tokens were generated in the *browser* (`generateRandomHexToken`) and never recorded server-side, so there was nothing to validate against and no way to revoke one. Agents are now rows in a new `Agent` table, authenticated by SHA-256 token hash before the connection is registered or the welcome payload is sent; unknown or revoked tokens are closed with `4001` and audited.
- **sec: the command signing key was ephemeral.** `AgentManager` generated an Ed25519 pair in its constructor, so it changed on every process start and the `public_key` an agent pinned in `agent.yml` stopped matching immediately. The key now lives in OpenBao at `secret/agent/signing-key` and survives restarts. If it cannot be loaded the SSO **refuses** to send high-risk commands rather than signing with a key no agent has seen (`signingAvailable: false` on `GET /api/agent/nodes`).
- **sec: commands are addressed by agent id, not token.** A credential has no business in a URL, an access log or browser history.
- **sec: agent actions are audited.** Enroll, update, rotate, revoke, delete, every command (with `signed`), and every rejected connection are emitted as structured `"component":"agent"` log records carrying the acting user.

### theta-agent — enrollment & resource binding

- feat: `POST /api/agent/enroll` mints the token server-side and returns it **once**; only its SHA-256 is stored. Plus `PUT /nodes/:id` (rename/rebind), `POST /nodes/:id/rotate`, `POST /nodes/:id/revoke`, `DELETE /nodes/:id`. Rotate, revoke and delete drop the live socket immediately (`4004`/`4003`) instead of waiting for a reconnect.
- feat: an agent binds to a **host resource** (`resourceId`). The Directory reads that link instead of guessing by hostname — the old `agentsByHost[name]` match silently failed whenever a Directory name differed from the machine's hostname, and aliased two hosts that shared one.
- feat: **agent discovery reaches the Directory.** A bound agent's facts (`os`, `kernel`, `cpu`, `ram_total_gb`, `disk_total_gb`, `ip`) are written onto its host resource, tagged `discovery_sources: ["theta-agent"]` with an `agentId` back-reference. An unbound agent goes through the normal reconciler. Previously `handleDiscovery` wrote to an in-memory record and updated nothing — the one source actually running *on* the host contributed nothing to the directory.
- feat: agent state is persisted, so an agent that is installed but **offline** is now distinguishable from one that never existed; enrollments survive a restart. The Directory status dot reflects this: red means "enrolled and not connected" (a fault), grey means no agent enrolled / revoked / service unreachable. Red previously covered both, making an ordinary directory of hosts look like an outage.
- feat: the Install Agent modal enrolls first and builds the install command from the result, including `--public-key`. `public_key` was never emitted into the generated `agent.yml` before, so no installed agent could verify anything.
- fix: `registerAgent` is synchronous. Awaiting a database write before attaching the WebSocket `message` listener lost every agent's first `discovery` frame, which it sends the instant the socket opens (`ws` drops events emitted with no listener attached).

### Directory

- feat: **the resource tree is collapsible.** Any row with children has a caret; the toolbar collapses/expands everything. State persists per browser, so the shape survives the self-heal reload that follows most edits. An active search overrides collapse so matches inside a folded subtree are never hidden.
- fix: **the Proxmox plugin mismatched MAC addresses to IPs.** It collected MACs and IPs into two flat lists and zipped them by index, so on any multi-NIC guest — or any guest where one NIC had no address — the directory recorded an address against the wrong MAC. NICs are now keyed by MAC, so a pairing can only come from the source that observed both together.
- feat: Proxmox discovery emits an **endpoint resource** (named from `/cluster/status`) with every node parented beneath it, so one endpoint is one subtree instead of several orphan roots. It deliberately carries no IP: giving it the address it is reached at made the reconciler merge it with the node answering on that address, producing a resource that was its own parent.
- feat: discovered guests carry `sourceId` (`<node>/qemu/<vmid>`), `node`, `vmid` and `macAddress`, so a row traces back to the exact guest on the exact hypervisor. Against a live 3-node cluster this took MAC coverage to 53/54 resources and `sourceId` to 54/54.
- fix: Proxmox interfaces belonging to something running *inside* a guest (`docker0`, `veth*`, `br-*`, VPN tunnels) are filtered out — one Home Assistant VM reported 16 of them alongside its single real NIC, and their 172.x addresses gave the reconciler spurious matches.
- fix: a stopped VM still reports its MAC (read from the VM config), a DHCP-configured LXC gets its address from the running container's interface list, and Proxmox **nodes** report their own IP/MAC (recovered from `enx<mac>` predictable names, since `/nodes/*/network` carries no `hwaddr`). Offline nodes are recorded with `status` instead of skipped, so a hypervisor that is down no longer looks decommissioned and get garbage-collected after a week.
- fix: **the reconciler could make a resource its own parent.** Two slugs in one payload can resolve to the same row once merged; the resulting self-edge renders as an infinitely nested tree and defeats every ancestor walk in the app. Self-edges and cycle-closing edges are now refused and logged.
- fix: **hosts were named after their MAC address.** `bestName` preferred the *longer* name, so UniFi's `ac:16:2d:b3:da:80` (17 chars) beat Proxmox's real hostname `dl380-0` (7). Names are now ranked (hostname > IP > MAC) with length only as a tie-break within a rank.
- fix: `isIp` never matched anything — `\\.` inside a regex literal matches a backslash, not a dot — so an IP-shaped placeholder name was never replaced by a real hostname a later source discovered.
- fix: a discovered device can only merge into a resource of the same kind. A VM named `gitea-runner` could match a hand-created *service* of the same name on the name rule and overwrite it.
- perf: the reconciler reads the inventory once per run instead of once per incoming resource — a ~55-resource Proxmox payload against a similar-sized inventory was doing quadratic full-table reads every run.
- fix: the Discovered Inventory table showed "Unknown IP" for almost everything, because it read `metadata.ip` while any source that enumerates interfaces stores addresses per-NIC. It now falls back to the first NIC address, and shows `vmid`, slug, `sourceId` and per-interface MAC/name.

### Profile

- fix: the API Tokens card is no longer wider than every other card on the site — the section sat outside the page's `.container`.

### Build & docs

- fix: `Dockerfile.test-runner` never copied `nodejs/plugins`, so every plugin test suite failed in CI as "Cannot find module" and plugin code was effectively untested. Suite count goes 27 → 29.
- docs: `docs/agents.md` rewritten for enrollment, the close-code table, resource binding, the persistent signing key, and a corrected `public_key` example (the documented `MCowBQYDK2VwAyEA...` was an SPKI PEM body — 44 bytes decoded — where the agent requires the raw 32).
- docs: `docs/directory.md` covers the collapsible tree and the corrected seed hierarchy; `docs/plugins.md` documents what the Proxmox plugin produces and why the endpoint has no IP.

# v1.28.0
- fix: `/api/agent/nodes` no longer 404s — the previous "unconditional mount" was still inside the post-listen `onListen` hook, so the REST router landed *behind* app.js's terminal 404 catch-all and every `/api/agent/*` request 404'd. The router is now mounted synchronously in `app.js` before the 404 handler; only the agent WebSocket setup runs on `onListen`.
- feat: promoting a discovered inventory resource now opens the resource form pre-filled with the discovered data (name, kind, IP, subtype, …) for review; the modal's Save confirms the promote (creates the LDAP groups + marks it managed) instead of silently promoting.
- fix: Directory table no longer goes stale after add/remove edge — `addEdge`/`removeEdge` called an undefined `loadData()`, which threw and left the host/parent linkage stale until a manual refresh; they now call `loadResources()`. `addGroup`/`removeGroup` also refresh so the Access column stays accurate.
- feat: Vault page states it's powered by OpenBao (header badge linking to openbao.org).

# v1.27.0
- fix: Directory group names now match `docs/GROUPS.md` exactly — per-resource groups are `{site}_{kind}_{name}_{level}` (`site_local_host_theta-env_access`, `site_local_app_sso-manager_access`), with the kind always present and the resource name slug stripped of its kind prefix. Services map to the `app` kind. The access-request + resolver tests were updated to the documented convention.
- fix: a site resource now carries only `god_admin` + the site-wide groups (`{site}_super_admin`, `{site}_everyone`); the kind-scoped aggregates are still created for nesting but are no longer surfaced on the site's modal.
- fix: groups no longer appear 3× under a resource — the Directory self-heal (which runs on every load) was creating duplicate `ResourceGroup` links; linking is now idempotent (check-then-create).
- fix: `/api/agent/nodes` no longer 404s — the agent REST router is mounted unconditionally instead of being gated on the WebSocket server being up.
- fix: `POST /api/shared-secrets/` rejected valid slugs — the slug regex now allows underscores (was hyphens-only).
- fix: `GET /api/shared-secrets/` crashed with `s.path is not a function` — the list spread dropped the instance's `path()` method; now uses the static `SharedSecret.pathFor`.
- fix: promoting a discovered inventory resource crashed with `Resource.update is not a function` — `update` is an instance method; the promote handler now loads an instance and calls `update()` on it.
- feat: Vault → Apps tab now lists minted app tokens (the "Minted apps" list) — each is a scoped OpenBao credential for an external service; sso renews them and the list shows renewal state, so a minted credential no longer vanishes after its once-only token display. New `GET /api/vault/apps`.
- feat: Vault page documents itself — a `/docs/vault` help icon in the header, and the doc now covers the Apps + Shared tabs.
- feat: discovery plugin cards show last-run time + status (ok/error) and a Logs button that opens the captured run log.

# v1.26.1
- fix: the legacy `app_super_admin` group is gone — `SUPER_ADMIN_GROUP` (nested into every resource's `_admin` group by auto-provisioning) is now `god_admin`, and `docker-entrypoint.sh` no longer seeds or nests `app_super_admin` (god_admin is nested into the `app_sso_*` groups directly). `isSuperAdmin` still recognizes a pre-existing `app_super_admin` as a migration alias, so an old deployment isn't stripped of rights until it's rebuilt.

# v1.26.0
- feat: complete the group model (docs/GROUPS.md) — `god_admin` is now seeded into LDAP and nested into `app_super_admin`; every site auto-provisions `{site}_super_admin`, `{site}_hosts_*`/`{site}_apps_*` aggregates and `{site}_everyone`; per-resource `_admin`/`_access` groups (named `{site}_{slug}_{level}`, the kind carried in the resource slug) are nested into the site aggregates so the inheritance lattice exists in LDAP, not just in the resolver. Site/aggregate groups are self-healed idempotently on every Directory load, so a directory seeded by an older release picks them up without a rebuild.
- feat: the naming convention is now enforced server-side — `POST /api/directory-admin/groups` rejects a group CN that isn't a valid group for the target resource (its own `_admin`/`_access`/capability, a site aggregate, a site-level group, or `god_admin`), so the free-text field can no longer mint `*_accessmember`-style names
- feat: `god_admin` is managed from the Directory — the site resource modal surfaces `god_admin` + the site-level groups as associated groups, so its members (and the site's) are editable right there
- fix: Directory agent status dots no longer paint every host red when the `/api/agent/nodes` endpoint is unreachable (older app or transient outage) — they now show a neutral grey "agent service unreachable" instead of a false alarm
- fix: Profile + API Tokens cards are both full-width on the profile page (the API card was a narrower centered block)
- fix: in-app `/docs/<slug>` pages returned 500 — `Dockerfile.openldap` never copied the `docs/` tree into the image (only the root README/CHANGELOG/API/directory_spec), so every page but those few hit a missing-file error; the whole `docs/` dir now ships, and doc images are served at `/docs/images`
- test: group resolver tests now cover the prefixed site-slug convention (`site_local_...` is kept verbatim, not re-slugified to `site-local`)

# v1.25.0
- feat: hierarchical group & permission model (docs/GROUPS.md) — god_admin, {site}_super_admin, {site}_hosts_*/{site}_apps_* aggregates, and per-resource {site}_host_<slug>_admin/access/<capability>; inheritance resolver (admin implies access, capabilities explicit), meta everyone/{site}_everyone groups
- feat: remove the standalone Groups page — group management is tied to adopted Directory resources (help link to the model in the Directory toolbar)
- feat: console admin recognizes god_admin and site-scoped super/app-admin groups (legacy app_sso_admin/app_super_admin kept as migration aliases)

# v1.24.0
- feat: Agents merged into the Directory — removed the standalone Agents page. Host rows show a green/yellow/red theta-agent status dot (healthy / high-load / not connected) and the resource modal gained a Metrics tab with live telemetry + discovery
- feat: Discovery Plugins New-plugin modal — slug is now derived from the name (field removed), the cron field is a dropdown (hourly/daily/weekly + custom), and per-plugin settings are collected from the configSchema (e.g. Proxmox url/tokenId/tokenSecret) instead of an empty config
- feat: Directory resource slug is now read-only and derived from the name
- feat: Vault page restyled to match the rest of the site (bounded container, card + nav-tabs header, h4)
- feat: navbar — the username is no longer underlined; only the active nav link is bold + underlined

# v1.23.0
- fix: /api/vault proxy never injected X-Vault-Token — the true root cause of the recurring vault 403 "permission denied". The proxy declared its hook with http-proxy-middleware v3 syntax (`on: { proxyReq }`), which the installed HPM v2 silently ignores, so every request reached OpenBao unauthenticated (and the client's sso auth headers were never stripped). Rewritten as v2 `onProxyReq`.
- fix: vault proxy header injection ordered before `fixRequestBody` — the body write flushes headers, so setting X-Vault-Token after it silently failed on every POST/PUT (writes would still 403 even with the hook fixed)
- fix: initORM add-only schema heal — `sequelize.sync()` never ALTERs existing tables, so columns added by newer releases (e.g. `PluginInstance.lastLog`, which crashed the scheduler on every boot of an upgraded deployment) are now detected via describeTable and added with addColumn (additive only, per-column fail-soft)
- feat: external-app vault tokens are long-lived and auto-renewed — minted via the new `sso-app` token role (periodic 768h, falls back to sso-broker's 24h role until theta-suite setup.sh is re-run); sso stores each token's accessor (new VaultAppToken model — an accessor can renew/revoke but not authenticate) and renews all of them at boot + every 6h via auth/token/renew-accessor, so a downstream app's credential stays valid as long as sso runs with zero renewal code in the app
- feat: re-minting an app token revokes the app's previous token via its stored accessor — exactly one live credential per app, no zombies
- test: wire-level tests for the vault proxy (real HTTP round-trip asserting token injection, auth-header stripping, path rewrite, and POST body integrity) + app-token accessor lifecycle tests

# v1.22.0
- feat: Agents page — live list of connected theta-agent hosts with telemetry (CPU/RAM/disk/ZFS/GPU) + online status, updating via socket.io
- security: auth + admin-gate the /api/agent REST routes (previously unauthenticated)

# v1.21.0
- fix: always reconcile OpenBao policy content before serving a (possibly cached) token, so stale stored policies can no longer cause a recurring vault 403 "permission denied"
- feat: shared secrets — users can publish secrets to secret/shared/<owner>/<slug> and grant read access to other users and downstream apps (OpenBao ACL policy edits, applied live)
- feat: shared-secrets API + Shared tab in the vault UI

# v1.20.0
- fix: OpenBao 403 on vault secrets list (directory list grants + policy self-heal)

## v1.19.0
- Added WebSocket endpoint for theta-agent C2

# v1.18.0
- feat: Add messaging plugins, Docker discovery, fix reconciliation

# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
correspond to git tags (`vX.Y.Z`) and `nodejs/package.json`'s `version`.

## [1.17.2] - 2026-08-01

Post-deploy fixes from testing the v1.31.0 stack, plus the SMS (VoIP.ms) and
Terms-of-Service configuration the `/conf` page was missing. Seven issues:

### Fixed
- **Plugin slug is now auto-generated** from the instance name — the New Plugin
  modal no longer asks for a Slug (it derived a stable, unique handle from the
  name, appending `-2`, `-3`, … on collision). The generated slug still shows in
  the table and the Edit (read-only) modal. `POST /api/plugins` `slug` is now
  optional; an explicit slug is still accepted and validated. (`routes/api_plugins.js`,
  `views/plugins.ejs`)
- **Plugin schedule is a dropdown**, not a raw cron box: Hourly / Daily /
  Weekly, plus **Custom** which reveals the raw 5-field cron input. Stored value
  is still a cron string, so the server is unchanged. (`views/plugins.ejs`)
- **`/vault` secrets list no longer 403s.** Root cause: the per-user, per-app,
  and admin OpenBao policies granted `list` only on `secret/metadata/.../*`
  (nested paths), never on the directory path itself — so listing a directory's
  *contents* (which checks `list` on the directory, e.g. `secret/metadata/users/<uid>`
  or the mount root `secret/metadata`) was denied. `vault_broker.js`'s
  `userPolicyHcl`/`appPolicyHcl` now also grant `list` on the bare directory
  path, and `ensurePolicy` now always re-writes the policy (idempotent) so
  already-created `user-<uid>` policies pick up the new grant on the next
  vault-page visit. The matching `sso-admin` mount-root grant ships in
  theta-suite v1.31.1 (`setup.sh`), where `ensure_policy` is likewise made
  always-write so re-running `./setup.sh` applies policy edits.
- **`/profile` no longer shows literal `{{…}}` tags.** Three template fragments
  sat outside the `jq-repeat="user"` scope, so they rendered raw: the card
  header `Profile: {{user.uid}}`, the `Members of {{user.uid}}'s Group` tab
  label, and the Admin Actions block's `{{#isActive}}`/`{{#isInactive}}`
  buttons. The header/label are now populated by JS (the `Members` label
  already had a setter pointing at a missing id); the Admin Actions block is
  moved inside the scope so `{{uid}}`/`{{#isActive}}`/`{{#isInactive}}` render
  and the correct Activate/Deactivate button shows. (`views/profile.ejs`)
- **Editing a plugin now persists.** The Edit modal had been prefilled with the
  masked secret values and rendered them as fields, but `PUT /:id` only saves
  non-secret config — so an edited secret was silently dropped. The Edit modal
  now shows **non-secret fields only** (secrets have their own Edit-Secrets
  modal), removing the confusion. (`views/plugins.ejs`)
- **nmap plugin: "NMAP not found at command location: nmap"** — the `nmap`
  binary was not installed in the app image. `Dockerfile.openldap` now `apk
  add`s `nmap` in the runtime stage, and `plugins/discovery/nmap.js` translates
  the opaque node-nmap spawn-missing error into an actionable `lastError`.

### Added
- **SMS (VoIP.ms) configuration on `/conf`.** The existing VoIP.ms SMS sender
  (`models/sms.js`, used for 2FA OTP delivery) was configurable only via env /
  config files. It now has an SMS card on `/conf` (API username, DID, API
  password), saved to OpenBao at `secret/sso-manager/conf` under `voipms`, with
  the API password masked (`********`) and leave-blank-to-keep — mirroring the
  SMTP card exactly. `models/sms.js` reads `conf.voipms.*` at call time, so a
  saved change takes effect live without a restart. (`routes/api_conf.js`,
  `views/conf.ejs`)
- **Terms of Service editor moved to `/conf`** from the admin Overview
  dashboard, where it never belonged. The same `app.tos.get`/`update` flow,
  the "require all users to re-accept" checkbox, and the `app_sso_admin` gate
  (matching `routes/tos.js`'s PUT gate) are preserved. The Overview page keeps
  stats, notifications, and metrics. (`views/conf.ejs`, `views/overview.ejs`)

### Notes
- The `/vault` 403 fix is split across two repos: the sso-side per-user/app
  policy grants and `ensurePolicy`-always-write ship here; the `sso-admin`
  mount-root grant and `ensure_policy`-always-write ship in theta-suite v1.31.1.
  Re-running `./setup.sh` after upgrading applies the sso-admin grant; per-user
  policies self-heal on the next vault-page visit.

## [1.17.1] - 2026-08-01

Hardens the **runtime SMTP/OAuth secret handling** on the `/conf` admin page to
match the plugin-secrets discipline: the SMTP password and OAuth JWT secret are
no longer returned in cleartext by `GET /api/conf` or round-tripped through the
form. They remain saved in OpenBao at `secret/sso-manager/conf` at runtime
(unchanged) — only how they're surfaced to the admin changes.

### Changed
- **`GET /api/conf`** now masks `smtp.pass` and `oauth.jwtSecret` to `********`
  (was: returned in cleartext). Non-secret fields (host, port, user, from,
  secure, issuer, token lifetimes) are returned as before.
- **`POST /api/conf`** now treats a blank or `********` secret-field submission
  as "keep the current stored value" — so an admin editing the From address or
  token lifetimes no longer has to re-enter (or leak) the SMTP password / JWT
  secret. Only a genuinely new, non-blank value overwrites. The preserved values
  are re-applied to live `conf` immediately, as before.
- **`/conf` page** (`views/conf.ejs`): the Password and JWT Secret fields carry
  a "leave unchanged to keep the current value stored in OpenBao" hint; the page
  copy notes secret fields are masked. No JSON-textarea editing is involved —
  SMTP is and remains configured through structured form fields.

### Notes
- SMTP (and OAuth) config was **already** saved to OpenBao at runtime before
  this release (via `POST /api/conf` → `baoConf.set('sso-manager/conf')`, and
  overlaid back at boot by `bao-conf.init`). This release closes the
  cleartext-exposure gap; it does not move the storage path.
- No theta-suite policy change required — `secret/sso-manager/conf` was already
  granted to the `sso-broker` policy.

## [1.17.0] - 2026-08-01

A real **plugin system**: the half-built discovery plugins (statically
configured in `sso-secrets.js`, only toggleable for cron/enabled) become
**configurable, loadable/unloadable plugin instances** you manage from a
dedicated **Plugins** page and the `/api/plugins` API, with multiple runtime
copies of each type and per-instance secrets stored in OpenBao.

### Added
- **Plugin instances** — a new `PluginInstance` ORM model
  (`nodejs/models/plugin_instance.js`, Sequelize) is the registry of
  configured, scheduled plugin copies. Each has a `pluginType`, a unique
  `slug` (the discovery source name), a cron schedule, an `enabled` flag
  (load/unload), non-secret `config` (JSON), and last-run bookkeeping. Multiple
  instances of the same type are supported.
- **Plugin registry** (`nodejs/services/plugin_registry.js`) — generalizes the
  one-shot discovery-plugin scan in `scheduler.js`. Plugin types are modules
  under `nodejs/plugins/<category>/<type>.js` exporting a manifest
  (`type`, `category`, `name`, `description`, `configSchema`, `validate`,
  `run`/`discover`). Exposes `getTypes`, `getModule`, `splitConfig` (secret vs
  non-secret), `mask`, and required-field helpers for the UI/API.
- **Per-instance secrets in OpenBao** (`nodejs/utils/plugin_secrets.js`) —
  `configSchema` fields flagged `secret:true` (e.g. a Proxmox `tokenSecret`,
  UniFi `password`) are stored at `secret/plugins/<instance-id>/conf`, never in
  the DB. The UI only ever sees masked (`********`) values. Plugins run
  in-process (BullMQ workers), so they need no OpenBao token of their own — the
  SSO reads/writes via the `sso-broker` token. **Requires theta-suite ≥ v1.30.1**
  for the `sso-broker` policy grant on `secret/plugins/*`; the API fails-soft
  with a clear error if absent.
- **`/api/plugins` API** (`nodejs/routes/api_plugins.js`, replaces the old
  `routes/plugins.js`) — `GET /types`, list/get/create/update/update-secrets/
  test/load/unload/run/delete/runs. Admin-only
  (`app_sso_admin` / `app_sso_directory_admin` / `app_super_admin`).
- **Plugins page** (`/plugins`, `views/plugins.ejs`) + nav entry — instance
  table with New/Edit/Edit-Secrets/Test/Run-now/Load/Unload/Delete, config forms
  rendered from each type's `configSchema`.
- **`validate`** ("Test" button) on the built-in Proxmox/UniFi/Nmap plugins.

### Changed
- `services/scheduler.js` now schedules from the `PluginInstance` table instead
  of static `conf.discovery.plugins` + a Redis override hash. Each instance owns
  a stable BullMQ JobScheduler id (`plugin:<instanceId>`) so load/unload
  upsert/remove one schedule without disturbing the rest. Discovery plugins
  reconcile results under the instance's `slug`.
- The three discovery plugins (`plugins/discovery/{proxmox,unifi,nmap}.js`)
  gained manifests (`configSchema`, `validate`, `run` alias). `nmap`'s
  `targetRange` is non-secret; Proxmox `tokenSecret` and UniFi `password` are
  secret.
- The `/plugins` page route renders the page instead of redirecting to
  `/directory`; the **Agents & Scheduler** tab was removed from `/directory`
  (plugins are now managed on the Plugins page). The `/docs/agents` link is
  aliased to `/docs/plugins`.
- `docs/plugins.md`, `docs/vault.md`, `docs/_config.yml` (nav), and `API.md`
  (Plugin Endpoints section) document the new system.

### Legacy migration
On first boot of v1.17.0, if the `PluginInstance` table is empty **and**
`conf.discovery.plugins` has entries, one instance per configured type is seeded
automatically (secret fields copied into OpenBao). After that the static
config is ignored — manage plugins from the UI/API. Idempotent (guarded by the
empty-table check).

### Prerequisite
**theta-suite ≥ v1.30.1** — re-run `./setup.sh` after upgrading so the
`sso-broker` OpenBao policy is granted `secret/plugins/*`. Without it, storing
plugin secrets fails with a clear error.

## [1.16.1] - 2026-08-01

Fix: the Configuration (`/conf`) and Vault (`/vault`) pages returned **401** for
a logged-in admin. Both view routes did server-side auth using `req.user`, but
this app's auth-token is a header set by client-side JS (localStorage), not a
cookie — so `req.user` is undefined on a plain browser navigation.
`permission.byGroup(undefined, …)` throws status 401, and the `middleware.auth`
gate on `/vault` threw `Auth.errors.login()` (401) for the same reason.

Both routes now render the shell unconditionally (like `/users`, `/directory`,
`/overview`) and gate client-side: `conf.ejs` already called
`app.auth.forceLogin(['admin','app_sso_admin'])`; `vault.ejs` now derives
`isAdmin` + the personal namespace from `/api/user/me` after `forceLogin()`
instead of server-rendering them. The `/api/conf` and `/api/vault` endpoints
still enforce `app_sso_admin` + the OpenBao scope server-side, so protection is
unchanged — only the view-route gating moved client-side where the session
actually lives. Also removed a dead duplicate `/conf` route definition.

## [1.16.0] - 2026-08-01

OpenBao becomes the central secrets store for the theta42 stack, and the SSO
Manager becomes its broker. This is the SSO's half of the move: it loads its
own secrets from OpenBao, mints scoped tokens for users and external apps,
and exposes a fixed, role-scoped personal-secrets UI.

### Changed
- **Secrets now load from OpenBao at boot** via
  [@simpleworkjs/bao-conf](https://simpleworkjs.github.io/bao-conf/), which
  deep-merges `secret/sso-manager/conf` over the file-loaded config
  (replacing the old `utils/conf_manager.js`, which did a shallow-per-key
  merge). `bin/www` runs `bao-conf.init()` after `models.initORM()` and
  before `listen`. Fail-soft: if OpenBao is unreachable, boot continues from
  `CONF_SECRETS`. The SSO authenticates with a scoped `VAULT_TOKEN` (policy
  `sso-broker`), never the root token. The admin **Configuration** UI
  (`/api/conf`) now writes through `bao-conf.set('sso-manager', …)`.
- **`/api/vault` proxy reworked** — the old endpoint was an ungated
  pass-through that never injected an `X-Vault-Token` (so the UI was both
  ungated *and* broken). It is now `middleware.auth` → `scopeGuard` → a
  token-injecting proxy. `scopeGuard` resolves a per-user (`user-<uid>`) or
  per-admin (`sso-admin`) token via the new `utils/vault_broker.js`
  (Redis-cached, minted through the `sso-broker` token role) and enforces a
  path prefix as a second layer on top of the OpenBao policy. The client
  `auth-token` is stripped; only the server-minted token reaches OpenBao.
- **Vault UI reworked and renamed** (`views/vaultwarden.ejs` →
  `views/vault.ejs`; the `/vault` route is now `middleware.auth`-gated).
  Non-admin users see only their `secret/users/<uid>/` namespace; admins get
  free-form path entry across `secret/` plus an **Apps** tab to mint scoped
  tokens for external apps (`secret/apps/<name>/*`, shown once with copy +
  `curl` convention).
- Bumped package version to track the release tag.

### Removed
- `nodejs/utils/conf_manager.js` (replaced by `@simpleworkjs/bao-conf`).
- `nodejs/views/vaultwarden.ejs` (renamed `vault.ejs`).

### Security
- **Committed-secrets remediation.** `config/sso-secrets.js` (LDAP bind
  password, SMTP, `oauth.jwtSecret`) and `nodejs/test_plugins.js` (a
  hardcoded Proxmox root API token and a UniFi password) were tracked on
  master. They are now untracked + gitignored (`config/*-secrets.js`), and
  `test_plugins.js` is deleted; `config/proxy-secrets.js.example` added as a
  placeholder template. **The secrets remain in git history — rotation at
  the providers is the real remediation and is the operator's to perform.**
  OpenBao is now the authoritative store; the local files are seed artifacts
  only.

> Note: releases v1.12.0–v1.15.2 were tagged from merge PRs without
> corresponding `CHANGELOG.md` entries or GitHub releases; this entry
> resumes the changelog at v1.16.0.

## [1.11.0] - 2026-07-31

Closes the end-user half of the directory. The admin side could describe the lab; the user side could not tell anyone what they had or how to use it, and several of the paths meant to do so were silently returning nothing.

### Fixed
- **`GET /api/discovery/me` returned only `isPublic` resources for every human caller.** It resolved the caller's groups from `req.user.groups`, which does not exist — `req.user` is a `User` carrying `memberOf` (DNs). The empty list failed open into "no group-granted resources", so "My Services" on the profile page and the portal's service list were blank for everyone. The same bug made `isDirectoryAdmin()` false for real directory admins, silently downgrading them to the public metadata projection. Group CNs now come from `utils/user_groups.js`.
- **The portal's "Discover More Services" was dead for every non-admin.** It called the admin-gated `directory-admin/resources` and swallowed the 403 into an empty array — so the one discovery feature never rendered for the audience it existed for. It now calls `/api/discovery/resources`.
- **Services reported no address.** `/api/discovery/me` had reimplemented `Resource.getMyAccess` without its parent-walking address resolution, leaving clients to guess `address || ip`, which is exactly wrong for a service that is reached at its host's IP. Both paths now share `Resource.withResolvedAddress()`.
- **Approving access for a user already in the target group threw a 500** and left the request stuck pending. `groupOfNames` requires at least one member, so a resource's auto-created groups are seeded with the creator's DN; the grant is now idempotent.
- **`DELETE /api/directory-admin/resources/:id` deleted the resource before its edges and group links.** With no transaction, a failure mid-way orphaned rows pointing at a nonexistent id — invisible in the UI and poisonous to `getGraph()`. Dependents go first now.
- `PUT /api/directory-admin/resources/:id` validated the body only after loading the row, and carried a dead if/else whose branches were identical.
- `/api/directory-admin/audit-logs` shelled out to `tail` three times via `execSync`; replaced with a bounded async file read (no `child_process`, at most the trailing 256 KB).

### Added
- **End-user catalog at `/`**, and the first ungated nav item — previously every nav entry was admin-only and a normal user had no signposted destination. Search/filter, per-kind icons, and a **how to reach it** block per card: the URL for a service, the SSH invocation for a host (using the jump-host `uid_-_slug@host` grammar when `directory.jumpHost` is configured).
- **Self-service access requests** — `AccessRequest` model plus `/api/access-requests` (create, list own, list decidable, approve, deny, withdraw). Approving performs the LDAP group add, so LDAP remains the access-control truth. Requests target a resource's `member`-level group, never its `_admin` one. Replaces the "coming soon" stub.
- **Admin access visibility**: an Access column on the directory table showing member and group counts (and flagging links whose LDAP group has been deleted), plus a "what can this user reach" lookup — the reverse question, which previously had no UI at all. Backed by `GET /api/directory-admin/access-summary` and `/user-access/:uid`.
- `conf.directory` — `jumpHost` and `defaultSshPort`, the connection conventions the catalog renders.
- `tests/access_request.test.js` — the request → approve → grant-is-real loop end to end, including the regression guard for the `user.groups` bug.

### Added — nested groups
- **A group can now contain another group.** `groupOfNames.member` accepts any DN, so nesting needs no new schema; what it needs is *resolution*, which no released OpenLDAP performs — `memberOf` and `(member=X)` both return direct membership only. Two halves:
  - **Server-side**: the all-in-one image now builds slapd from a pinned OpenLDAP master commit (`350e9eb3`) to get the **`nestgroup`** overlay (ITS#10161), enabled with `member-filter memberof-filter memberof-values`. `member-values` is deliberately omitted — it expands `member` when reading a group, which destroys the distinction between "listed here" and "reachable via nesting" and is not recoverable afterwards. `pw-sha2` is built from contrib in the same stage; without it every existing `{SSHA512}` password would be unverifiable.
  - **Client-side**: `Group.list(dn)` computes the transitive closure itself (cycle-detected, depth-capped) when the server can't, selected by `conf.ldap.nestedGroupsServerSide` — which `docker-entrypoint.sh` derives from probing for `nestgroup.so` rather than hardcoding. Both paths are covered by the full suite.
- `PUT`/`DELETE /api/group/:group/nested/:child` and `GET /api/group/:group/effective`, plus a **Nested** tab on each group card. Cycles are refused (409) rather than silently depth-truncated.
- **`app_super_admin` is now seeded** (it never was) and nested into `app_sso_admin` / `app_sso_invite` / `app_sso_oauth_admin`, so the privilege is real LDAP membership visible to SSSD and sudo — not just a special case in `utils/permission.js`. Not nested into `app_sso_service_account`, which marks non-person accounts rather than granting anything.
- Creating a directory resource nests `app_super_admin → <slug>_admin` and `<slug>_admin → <slug>_access`. Both previously required adding every super admin to every new group by hand, so they drifted.
- `ldap_group_nesting_level = 5` in ldap-client's SSSD template, for hosts pointed at a server without `nestgroup`. Against the bundled slapd the existing `memberof=` access filter is already transitive, so SSH login inherits nesting for free.

### Fixed
- `PUT /api/group/:group/:uid` returned a bare **500** when the user was already a member — common, since `groupOfNames` requires a member and so seeds whoever created the group. Now a 409 that says so.
- Un-nesting (or removing) the last member of a group returned a 500 `ObjectClassViolationError`; now a 409 explaining that a group must keep at least one member.
- `GET /api/user/me` derived `isAdmin` from `memberOf`, which is only transitive when `nestgroup` is present. Against a stock server an admin holding their group via nesting would get `isAdmin=false` and lose the entire admin UI while still passing every server-side permission check.
- `utils/permission.js`'s `byGroup` checked `group.member.includes(user.dn)` per group, seeing only direct membership.
- `/api/directory-admin/access-summary` counted `member` values; it now counts the transitive closure, which matters precisely because `app_super_admin` is nested into every resource's admin group.
- Broken `api.html` link in the published docs (`API.md` lives at the repo root, so Jekyll never rendered one); pointed at the source, and added an API entry to the docs nav.

### Changed
- `@simpleworkjs/directory-schema` bumped to `^1.1.0`, which declares the ten metadata keys the admin form has always written but the schema never listed (`port`, `externalPort`, `isExternalReachable`, `os`, `gitRepo`, `isCurrentSite` as public; `vmid`, `macAddress`, `installPath`, `systemdService` as admin-only). Undeclared keys are dropped for non-admin callers, which blanked the portal's `OS:` field, hid every service's port from users, and left machine tokens unable to read the port mapping the firewall consumer exists to render.
- Resource metadata now includes `icon` and `tagline`, collected on the admin form (with a live icon preview) and rendered on the catalog cards.

## [1.10.0] - 2026-07-30

### Added
- **`app_super_admin` cross-app group**: members are full admins here regardless of `app_sso_admin` membership. Bypassed centrally in `utils/permission.js`'s `byGroup`, folded into `GET /api/user/me`'s `isAdmin` flag, and added to nav/`forceLogin` gates. The same group is now also recognized by proxy and jump-host, and by `ldap-client`'s SSSD access filter (SSH login on every host).

### Changed
- **Renamed the Executive page to Overview** (route, view, `/api/metrics/overview`, nav label, docs). `/executive` kept as a 301 redirect alongside the existing `/admin`, `/notifications`, `/dashboard` legacy redirects.

## [1.9.0] - 2026-07-28

### Added
- **Directory modal's Associated LDAP Groups tab now supports full membership management**: view, add, and remove members/owners of each associated group directly from the tab, reusing the same `PUT`/`DELETE group/:group/:uid` routes and member-mapping pattern already used on the Groups page.
- **`app.util.revealItem()`** (in the shared `app-base.js`, byte-identical across the 3 apps): scrolls a just-added/-edited element into view and flashes its background. Wired into the Directory table, the Groups tab's member list, and the Groups page's create-group flow.

### Changed
- **Groups page's search/sort bar is now sticky**, staying visible while scrolling through a long group list. Introduces `--sw-content-offset` (set in `top.ejs` alongside `#spa-shell`'s margin-top) so an in-page sticky element can offset itself below the fixed navbar/update-banner instead of being hidden behind them.
- **Directory table**: Kind/Name/Env/Host merged into a single "Resource" column.
- `@simpleworkjs/frontend` bumped to `^0.2.7`.

## [1.8.3] - 2026-07-28

### Changed
- **`profile.ejs`'s self-service API-token UI unified onto `app.modal`**, matching the pattern already shipped this round in `directory.ejs`, proxy, and jump-host: the static `#secretModal`/`#editModal` elements are retired in favor of the shared `app.modal` singleton, the always-visible inline create-form card becomes a "+ New Token" button + modal, and badge classes switch from `bg-*` to `text-bg-*`.
- Checkmark-flash copy feedback (silently broken by FontAwesome's `<i>`→`<svg>` replacement) replaced with toast-based `copyFieldValue`, matching proxy and jump-host.

## [1.8.2] - 2026-07-28

### Fixed
- **Creating a new OAuth integration didn't reliably show the "save this client secret now" reveal modal** — `saveResource()` called `app.modal.close()` immediately before conditionally showing the secret via `app.modal.open()`. `app.modal` is a singleton, and `close()` immediately followed by `open()` collides with Bootstrap's hide-transition guard. An intervening `await loadResources()` made this race unlikely to lose in practice, but not guaranteed to — found while fixing the same, guaranteed-to-lose bug in jump-host and proxy's API-token create flows.

## [1.8.1] - 2026-07-28

### Fixed
- **The resource modal's "Associated LDAP Groups" autocomplete went empty after the first Add/Edit** — `loadLdapGroups()`'s fetch-once cache guard (`if (ldapGroupsCache) return;`) also skipped repopulating the `<datalist>` on every call after the first, but the modal body (including that `<datalist>`) is rebuilt fresh and empty on every `app.modal.open()`. Now the fetch is still cached, but the datalist is always repopulated.

## [1.8.0] - 2026-07-28

### Added
- **Directory resource modal: General / Details / Associated LDAP Groups / Children tabs**, replacing one long form. The new Children tab lists a resource's existing children and lets you add another right from the modal.
- **Resource audit trail**: `created_by`/`created_on`/`updated_by`/`updated_on`, shown in the modal's new footer (mirrors the convention already used by proxy's `Host` and jump-host's `ApiToken`). Existing resources predating this change show "—" until next edited.
- **Linkable resource URLs**: `GET /directory/:slug` plus a client-side deep-link check make a resource's modal directly bookmarkable/shareable; the address bar updates to `/directory/{slug}` while its modal is open and reverts on close (including via the browser Back button).
- **Auto-created LDAP groups are now prefixed with their nearest ancestor Site's slug** (e.g. `site_local_myhost_access` instead of `myhost_access`), so groups for same-named hosts/services under different sites no longer collide or look identical. Resources with no Site ancestor keep the old unprefixed naming.

### Changed
- `@simpleworkjs/frontend` bumped to 0.2.6: `app.modal` gained the `tabs`/`footer`/`url` options (all opt-in, existing callers unaffected) plus `showTab`/`on`/`deepLinkSlug`/`formatAudit`/`footerButtons` helpers — the shared building blocks behind this release's modal work, reusable by future entity modals in any of the 3 apps.

### Fixed
- The Directory's Associated LDAP Groups / Relationships lists no longer risk silently dropping their contents on a second modal open (a `jq-repeat`/DOM-rebuild timing race, now rendered manually instead).

### Operational note
The new `Resource` audit fields require a schema migration on any existing deployment: `ALTER TABLE Resource ADD COLUMN created_by VARCHAR(255); ALTER TABLE Resource ADD COLUMN created_on INTEGER; ALTER TABLE Resource ADD COLUMN updated_by VARCHAR(255); ALTER TABLE Resource ADD COLUMN updated_on INTEGER;` (adjust types for non-sqlite dialects) — `@simpleworkjs/orm`'s `sync()` only creates missing tables, it never alters existing ones.

## [1.7.0] - 2026-07-28

### Fixed
- **`formAJAX`'s loading indicator showed literal HTML** ("&lt;div class=..."), not a spinner — it passed raw markup to `app.messages.action`, which HTML-escapes its message by design. Replaced with plain text.
- **`POST /api/user/` (create) and `PUT /api/user/password` had no `message` field** in their response, so the success notification rendered empty. Added messages matching every other route's convention.
- **The user landing on `/login` with a `?redirect=` had no explanation why** — happens whenever another app's "Log in with SSO" bounces an unauthenticated user through `/oauth/authorize`. Now shows a contextual banner explaining what's happening.

### Changed
- **Directory: tree view is now the only view** (the list/tree toggle is gone) — simpler, one code path.
- **Directory: clicking a resource's name opens its detail modal**, not just the pencil/edit icon.

Found via a fresh production install's feedback — see the [theta-env v1.13.0 release](https://github.com/theta42/theta-env/releases) for the full cross-repo summary.

## [1.6.3] - 2026-07-28

### Fixed
- **Group membership changes (`PUT`/`DELETE /api/group/:group/:uid`) didn't invalidate the User cache**, so `isServiceAccount` (and anything else derived from `memberOf`) could stay stale for up to 5 minutes after a change. This is what caused a real "lost user" report — the account had landed in `app_sso_service_account` (which `users.ejs`'s People tab filters out entirely) and looked exactly like data loss, though nothing was ever deleted.

### Added
- **A confirmation before adding anyone to `app_sso_service_account`** via the Groups page — that group's whole purpose is to hide an account from the People tab, and there was no guardrail against doing that to a real person by mistake (which is how the bug above happened). Every other group's add-member flow is unchanged.

## [1.6.2] - 2026-07-28

### Fixed
- **`DELETE /api/oauth/client/:id` 500'd** (`client.remove is not a function`) — `OAuthClient` wraps `@simpleworkjs/orm`'s `Resource` model, whose instance delete method is `.delete()`, not `.remove()`. The Directory Management UI was unaffected (its own delete routes already used `.delete()` correctly); only this legacy/raw API endpoint was broken. Found live against a real deployment's SSO API.

### Added
- **Regression tests**: PUT/DELETE on `/api/oauth/client/:id` now verify persistence with a follow-up GET rather than trusting the mutating response alone (this is what would have caught the bug above). A static check across all views/client-side scripts fails CI if any native `alert()`/`confirm()`/`prompt()` call appears — these block all further browser events on the page and were fully removed in 1.6.1.

## [1.6.1] - 2026-07-27

### Fixed
- **Removed every native `alert()`/`confirm()` call**, replacing them with `app.messages.action`/`confirm`/`toast`. Native `confirm()` blocks all further browser events on the page (discovered live, mid browser-verification of the 1.6.0 `app.messages`/`app.modal` adoption, on `directory.ejs`'s "Rotate Client Secret" — it froze the whole tab). Also deleted `app.user.remove`/`app.oauthClient.remove` in `public/js/app.js`, which had native `confirm()` guards and zero callers anywhere in the app.

## [1.6.0] - 2026-07-27

### Changed
- **Adopted `@simpleworkjs/frontend`'s `app.messages`, `app.modal`, and `app.validate` modules**, replacing the vendored `app.util.actionMessage`/`actionConfirm`/`alert` in `public/lib/js/app-base.js` and the vendored `public/lib/js/val.js`. Message content is now HTML-escaped (the vendored `alert()` this replaces had no escaping), and `app.messages.action` falls back to a page-wide toast when there's no inline `.actionMessage` target. `app.api`/`app.auth`/`app.pubsub`/`app.socket` are untouched — they're app-specific (dual-mode callback/promise API, `auth-token` header injection) and not something the frontend package's generic `app.js` provides.

## [1.5.1] - 2026-07-27

### Fixed
- **`PUT /api/user/:uid` 500'd with `ObjectClassViolationError` (LDAP `0x41`) when setting `sshPublicKey`** on any account created before the `ldapPublicKey` auxiliary objectClass was added to new-user creation (e.g. the bootstrap `admin` account). `User.update`'s `sshPublicKey` handling and `User.addSSHkey` (`nodejs/models/user_ldap.js`) now add the `ldapPublicKey` objectClass first (ignoring `TypeOrValueExistsError` if already present), the same pattern already used for `dateOfBirth`/`theta42Person`.
- **OAuth Integration parent dropdown was blank.** `populateHostDropdown` in `nodejs/views/directory.ejs` only built options for `kind === 'host'` and `kind === 'service'` — there was no branch for `kind === 'oauth'`, so choosing "OAuth Integration" in the Directory's add-resource modal left the parent-Service picker empty except the placeholder. Added the missing branch.

## [1.5.0] - 2026-07-26

### Changed
- **Unified the front-end UI shell across the three theta42 apps.** `views/top.ejs`, `views/bottom.ejs` and `public/lib/js/app-base.js` are now byte-identical in sso-manager-node, proxy and jump-host, so the apps look and behave the same and a shell change lands in one edit per repo instead of three divergent ones. Everything that differs between the apps moved into a new `nodejs/utils/ui.js`, exposed to every render as `ui` via `app.locals`: nav items and the groups that may see them, footer repo/license/docs/Terms links, favicon, the profile and post-logout targets, and whether the update banner exists at all.
- **One nav-gating model everywhere.** `app-base.js` reveals `.group-required-<cn>` elements for each group the current user is in, read from `GET /api/user/me`. sso-manager-node reports LDAP DNs in `memberOf` and the OIDC clients report CNs in `groups`; both normalise to CNs client-side, and the clients' effective-rights `isAdmin` flag is exposed as a synthetic `admin` group — so one gating model covers a group-based provider and boolean-admin clients without either app learning the other's response shape.
- **`GET /api/user/me` is fetched once per page load and cached** (`app.auth.loadUser`). The nav, per-view `forceLogin` and every group-gated element read that one promise instead of issuing their own request.
- `app.auth.isLoggedIn` is dual-mode: it returns a Promise **and** invokes an optional node-style callback, so the async and callback call styles both work against one shared `top.ejs`.
- `app.auth.forceLogin` no longer uses `$.holdReady` (removed in jQuery 4). An unauthenticated user is redirected to `/login?redirect=<path>`; group requirements are still enforced, and `logOut` now only clears the session, leaving the destination to the caller (`ui.logoutRedirect`).
- Dependency alignment across all three apps: `jquery` `^4.0.0` and `ejs` `^3.1.10`.

### Fixed
- **`app.api.delete` dropped its callback when called by `formAJAX`.** `formAJAX` always passes the serialized form as the second argument, so a DELETE-method form's callback landed in the data slot and never ran. `delete` now accepts both `(url, callback)` and `(url, data, callback)`.
- **`app.api.post`/`put` referenced an undefined `callback2`** and threw when handed a non-function callback. Both are now dual-mode Promise/callback.
- **The login page's "reveal the card once we know you're logged out" branch threw** (`Cannot read properties of null`) whenever the logged-in check answered before the parser reached that element — which it always did without a stored token. It now runs on DOM ready.
- **`logInRedirect` on the legacy `/login/<path>` form kept only the path.** The OIDC provider routes an unauthenticated authorization request through `/login/oauth/authorize?client_id=…&state=…`; dropping the query there loses the entire authorization request. The suffix form now preserves its query string.

### Fixed (sso-manager-node)
- `public/lib/js/val.js` shadowed `message` with `let` inside `validateField`, so a custom rule's return value never reached `validateMessage` and the caller always saw the generic length message. Resolved by adopting the shared validator, which also brings the `target`/`hostname` rules and the real password policy (>= 8 chars, and either 12+ or 3 of 4 character classes) to this app.
- `public/js/app.js` used `$.isFunction`, removed in jQuery 4.

### Added (sso-manager-node)
- `GET /api/user/me` now also reports `isAdmin` (membership in `app_sso_admin`), the single effective-rights flag the shared UI shell gates the update banner on. Group-level gating still reads `memberOf`.

### Verified
- Browser-verified against a full theta-env stack (sso-manager + proxy + jump-host): every top-level page renders with a clean console; nav gating is correct for admin and non-admin; `forceLogin`'s onboarding and group gates fire; `val.js` blocks a weak password and accepts a strong one through a real form submit; the DELETE-method forms work; and the OIDC login round trip (authorize with PKCE -> login -> consent -> callback -> token fragment) completes on both OIDC clients.

## [1.4.0] - 2026-07-25

### Security
- **The directory discovery API leaked OAuth `client_secret_hash` (and any secret-ish metadata key) to every authenticated caller.** `Resource` doesn't override `toJSON`, so the ORM serialized `metadata` wholesale — including the `client_secret_hash` stored on `kind:'oauth'` resources — across `GET /api/discovery/resources`, `/graph`, `/me`, `/resources/:slug`, and the directory-admin `GET /api/directory-admin/resources`. Every discovery read endpoint and the admin list now route through `projectResource`/`projectResources` from `@simpleworkjs/directory-schema`, which unconditionally strips secret keys (anything matching `/secret|password|privatekey/i`, including `client_secret_hash`) and, for non-directory-admins, reduces metadata to a public allowlist. Admins never receive `client_secret_hash` either.

### Fixed
- **Directory discovery envelope drift.** `routes/discovery.js` (the `autoRouter(Resource)` mounted live at `app.js:87`) returned **bare arrays**, not the `{ results: [...] }` envelope the directory contract specifies — so jump-host's `data.results || []` collapsed every per-group query to `[]` and no user could bridge. Discovery is now served by explicit `/resources`, `/resources/:slug`, `/graph`, `/me` handlers that all return the `{ results }` envelope. The dead `routes/api_discovery.js` (mounted at `app.js:112`, *after* the 404 catcher) and its mount were removed.
- `GET /api/discovery/resources?group=<cn>` now returns 200 with `{ results: [...] }` instead of 404 (the autoRouter's `search` supported `?group=`, but the route was effectively unreachable for jump-host's call pattern).

### Added
- Adopted the shared `@simpleworkjs/*` packages published under the simpleworkjs org:
  - `@simpleworkjs/directory-schema` — the directory contract: the `kind` enum, `Resource`/`ResourceEdge`/`ResourceGroup` field defs, the `{ results }` envelope, the security projection (`projectResource`/`projectResources`/`isDirectoryAdmin`), and the discovery client. `models/resource.js` imports the field defs; the discovery + directory-admin routes use the projection.
  - `@simpleworkjs/ldap` — `models/user_ldap.js` and `models/group_ldap.js` now take `escapeFilter`/`escapeDN` and `makeClient`/`withClient` from the shared package (via local wrappers that pass `conf`); sso keeps its rich `User.get`/`Group.get`/`User.login`/`User.addSSHkey` (posix/write-side stays app-local). sso's `makeClient` passes no `tlsOptions`, so cert validation is unchanged.
  - `@simpleworkjs/app-stack` — unified `build_info` (`{buildVersion, buildHash, buildYear}`) and the `static-modules` mounting helper. `utils/build_info.js` and the static-modules loop in `routes/index.js` use the shared helpers.
- New `tests/discovery.test.js` (jest + supertest, runs under the docker harness): locks in the `{ results }` envelope on `/resources`, `/graph`, `/me`, `/resources/:slug`, the `?group=` 200-regression, and the no-`client_secret_hash`/no-secret-key guarantee for every caller.

### Changed
- Dependency alignment: `ldapts` `^8.1.2` → `^8.1.8`. The new `@simpleworkjs/*` deps resolve from the npm registry (`^1.0.0`); no `file:`/`link:` entries in the lockfile, so `npm ci` is clean in docker builds.
- `build_info` export shape changed from `{commit, version}` to `{buildVersion, buildHash, buildYear}` (the shared shape used by all three apps).

## [1.3.2] - 2026-07-23

### Fixed
- **OAuth client management API returned `client_id: undefined` on every GET.** The ORM's `Model.toJSON()` only serializes schema fields, so the mapped `client_id`/`scopes`/`redirect_uris`/… that `OAuthClient.get()` attaches to the wrapped Resource were stripped from `GET /api/oauth/client` and `GET /api/oauth/client/:id` responses. The theta-env bootstrap (which lists clients and rotates by the returned `client_id`) then called `/api/oauth/client/undefined/rotate` and got a 500, aborting stack bring-up when `proxy-secrets.js` had no usable secret. `OAuthClient.get()` now emits an explicit public JSON shape (and deliberately omits `client_secret_hash`, so the secret hash no longer leaks over the API).
- `OAuthClient.get()` no longer 500s on an unknown/`undefined` client id: `Resource.get()` returns `null` (it doesn't throw), which was dereferenced as `r.kind`. It now returns a clean 404.

## [1.3.1] - 2026-07-23

### Added
- The Directory documentation (`docs/directory.md`) is now surfaced: registered in-app at `/docs/directory` ("Directory & Inventory"), help-linked from the Directory page header, and linked from the docs-site index. Extended with the shared slug conventions (`site_<name>`, `host_<hostname>` — as used by ldap-client and the theta-env seed), the automatic-registration story (theta-env stack seeding, ldap-client Linux host enrollment), and the API surface (admin at `/api/directory-admin`, read-only graph at `/api/discovery`).

### Changed
- Direct LDAP binds are described as first-class, not "legacy", across README, DEPLOYMENT.md, docs, and the Dockerfile: Linux hosts are a primary consumer of the directory (PAM/SSSD login, LDAP-backed `sudo` via `sudoRole`, SSH public keys via openssh-lpk) — exactly what the custom schemas exist for.

## [1.3.0] - 2026-07-23

### Added
- **OAuth client management API** at `/api/oauth/client` (group `app_sso_oauth_admin`): list, create, update, delete, and rotate-secret for OAuth clients, backed by the Resource model. Accepts form-style string inputs (newline-separated `redirect_uris`/`allowed_groups`, space-separated `scopes`).
- **Dockerized test suite**: `docker-compose -f docker-compose.test.yml up --build` spins up OpenLDAP + Redis + a test-runner that seeds the test user and runs the full jest suite (174 tests) against them. `tests/globalSetup.js` honors `REDIS_URL`.

### Fixed
- Completed the model-redis → `@simpleworkjs/orm` port that shipped half-finished in 1.2.1:
  - `OtpToken.issue`/`verify` called nonexistent `find()`/`listDetail()` — every OTP login 500'd.
  - Impersonation create/revoke called nonexistent `ImpersonationToken.listDetail()` — both endpoints 500'd.
  - `OAuthClient` read `is_valid` from the Resource model, which has no such column — every client evaluated as disabled and **all `/oauth/authorize` requests were rejected with 400**. Client validity now lives in `metadata` (absent = valid).
  - `OAuthClient.add` didn't set the required-unique `Resource.slug`; clients now get a slug derived from the client name.
  - `GET /api/token/:name/:token` returned `{results: null}` with 200 for unknown tokens (orm `get()` returns null instead of throwing); now 404s.
- `User.login` returns a clean 401 instead of crashing when neither `uid` nor `username` is supplied.
- Depend on published `@simpleworkjs/orm` ^0.2.8 and `model-redis` ^1.6.0 instead of a local `file:` link that broke `npm ci` in docker builds.

### Changed
- Removed the Mobile Phone field from the user create/edit form.

## [1.2.1] - 2026-07-22

### Added
- **Actionable Metrics**: New real-time metrics tracking for failed logins, top IPs, and service usage per user.
- **LDAP Monitor**: Background service to parse OpenLDAP binds over port 389 and track metrics for legacy apps.
- **UI Updates**: Executive dashboard now displays actionable metrics cards instead of raw logs. User profiles show individual service usage stats to admins.
- **Directory Management**: Integrated site/host/service abstractions into directory UI and allowed associating OAuth apps directly to services.

## [1.1.18] - 2026-07-21

### Added
- N-Way Multi-Master LDAP replication: `LDAP_SERVER_ID` + `LDAP_REPLICATION_HOSTS` configure `syncrepl` peers in the bundled OpenLDAP, and a new `/sites` page (nav: **Sites**) shows each configured peer's LDAP URL and live reachability.
- A `location` property on users, editable from the profile and user-edit forms.

### Fixed
- `/sites` (added above) 500'd on every load: `views/sites.ejs` included nonexistent partials `header`/`footer` instead of this app's actual `top`/`bottom`. Fixed to match every other view.

### Changed
- Refreshed all README screenshots (dashboard, users, groups, OAuth apps) against the current UI, and added a new Sites & Replication screenshot.

## [1.1.17] - 2026-07-18

### Added
- `conf.ldap.ldapsHost` and `conf.ldap.ldapsPort` config options (also settable via `app_ldap__ldapsHost` / `app_ldap__ldapsPort`). When `ldapsHost` is set, the `/integrations` page advertises that hostname for direct LDAPS binds instead of deriving it from the public OAuth issuer. This lets operators use an internal-only hostname (e.g. `ldap.internal.example.com` or `sso-manager` on the Docker network) and avoid port-forwarding 636 to the internet.
- A contextual help panel on `/integrations` → LDAP explaining why LDAPS needs a hostname (not an IP), why 636 should not be publicly forwarded, and the recommended internal-DNS / Docker-internal alternatives.

### Changed
- `routes/index.js` now computes the displayed LDAPS URL from `conf.ldap.ldapsHost`/`ldapsPort` with fallback to the OAuth issuer host for backward compatibility.
- `secrets.js.example`, `docs/configuration.md`, `docs/ldap.md`, and `DEPLOYMENT.md` document the new `ldapsHost`/`ldapsPort` options and recommended network layouts.
- Bumped version to `1.1.17` in `nodejs/package.json`.

## [1.1.16] - 2026-07-18

### Security
- Hardened LDAP filter and DN construction against injection. All user-supplied values interpolated into group filters (`models/group_ldap.js`) and RDN values used when adding users/groups (`models/user_ldap.js`) are now escaped before being sent to the LDAP server.
- Replaced `Math.random()`-based token generation in `models/token.js`, `models/oauth_code.js`, and `models/oauth_client.js` with `crypto.randomUUID()` for session tokens, OAuth codes, access/refresh tokens, and client IDs.
- Replaced `Math.random()`-based OTP generation in `OtpToken.issue()` with `crypto.randomInt()`.
- `routes/oauth.js` now refuses to start if `oauth.jwtSecret` is missing or still set to the placeholder value, instead of falling back to a hardcoded public string.
- Rendered docs and Terms-of-Service HTML in `routes/docs.js` and `routes/index.js` are now sanitized with `xss` to prevent stored XSS from malicious markdown.
- Removed a `console.log` that wrote new-user data (including password hashes) to the log in `models/user_ldap.js`; reduced login-path error logging to `error.name`/`error.message` only.

### Changed
- Public-release packaging: removed `"private": true` from `nodejs/package.json` and bumped version to `1.1.16`.
- CI workflow (`.github/workflows/pr-tests.yml`) now sets `app_oauth__jwtSecret` so the test suite can run against the new startup-time JWT validation.

### Fixed
- `models/email.js`: fixed a template bug where the rendered `from` address used `template.message` instead of `template.from`.

## [1.1.15] - 2026-07-18

### Changed
- Rewrote `install.sh` as an idempotent git-clone installer, replacing the old flag-driven, copy-based one — `wget -O - .../install.sh | sudo bash` now works the same way it does for theta42/proxy. Installs to `/opt/theta42/sso-manager` (was `/opt/sso-manager`). First run only: bootstraps OpenLDAP with a generated admin password + JWT secret and seeds `/etc/sso-manager/secrets.js` (was `/opt/sso-manager/conf/secrets.js`, hand-filled from CLI flags); later runs never touch LDAP or the secrets file again. `ops/systemd/sso-manager.service` sets `CONF_SECRETS=/etc/sso-manager/secrets.js` to match.
- `install.sh` now prints the version it's updating from/to (or "Already up to date") on every run.

### Fixed
- `install.sh` could hang indefinitely on a fresh host if a base package pulled in `tzdata` as a new dependency (no TTY for the interactive timezone prompt), or if the debconf `slapd/domain` value was malformed (a raw DN fragment instead of a dotted domain) — slapd's postinst hangs rather than failing cleanly on a bad domain. Both fixed.
- `ops/ldap-setup.sh`'s ppolicy-overlay checks used an LDAP substring filter against an attribute that doesn't support substring matching, so they always reported the overlay as unconfigured even when it was correctly set up (stored as `{0}ppolicy`) — the final verification step always failed as a result. Fixed to filter on `(objectClass=olcOverlayConfig)` instead, matching every other check in that script.

## [1.1.14] - 2026-07-17

### Changed
- Bumped `@simpleworkjs/conf` to 1.2.0 and `jq-repeat` to 2.2.0. The Docker entrypoint now sets the new `CONF_SECRETS` env var to point directly at a mounted `sso-secrets.js` instead of symlinking it into `/app/conf/secrets.js` — the app no longer needs write access to its own `conf/` directory to pick up mounted secrets.

## [1.1.13] - 2026-07-17

### Fixed
- The new concept docs' cross-links (`concepts-accounts.html` etc.) are the correct, working URL on the Jekyll/GitHub Pages build (where the page's URL is its filename stem) but didn't resolve in the in-app docs viewer, which serves docs at a separate short slug (`/docs/accounts`). The in-app renderer now also resolves a doc's real filename as a fallback, so one link written in a doc works on both targets.

## [1.1.12] - 2026-07-17

### Added
- Three new plain-language docs aimed at less technical readers, replacing the schema-level LDAP/OAuth/API docs as the target of most card help links: **Accounts, Groups & Managers**, **Connecting Apps (SSO)**, and **API Tokens**. Each links onward to the deeper technical reference for readers who want it; the technical docs link back the other way too. The personal-access-token card (previously missed) now links to its own doc.

### Fixed
- The in-app docs viewer rendered every `docs/*.md` page with a garbled heading and a stray horizontal rule at the top — Jekyll front matter (meant only for the GitHub Pages build) was never stripped before being handed to the markdown renderer. Also fixed: cross-doc links (`ldap.html`, `index.html`, etc.) never resolved in-app, since this viewer serves docs at `/docs/<slug>` with no `.html` suffix — they're now rewritten to the correct in-app URL, the same way image paths already were.

## [1.1.11] - 2026-07-17

### Changed
- Moved the help (❓) link out of the global header and onto each relevant card individually (Invite User, Add new user, User List, Service Accounts, group cards, OAuth/LDAP integration cards, My groups, Members of `<uid>`'s group, New API Token) — each now deep-links straight to the doc that actually covers it, instead of one generic header icon.

## [1.1.10] - 2026-07-17

### Added
- A help icon (❓) in the top-right header now deep-links to the doc most relevant to the current page (falls back to the docs index elsewhere).
- The in-app docs viewer (`/docs`) is now searchable — a simple line-substring search over the same local doc set, no new dependency, still works with no internet access.

## [1.1.9] - 2026-07-17

### Added
- Every account's personal Unix group (its primary GID holder) can now have supplementary members managed from the account's profile page ("Members of `<uid>`'s group", admin-only) — e.g. to share write access to files owned by that group. Uses the standard `memberUid` attribute (RFC 2307 `posixGroup`).

## [1.1.8] - 2026-07-17

### Added
- Group membership is now editable directly from a user's profile page ("My groups" -- add via a group-name picker, remove with a button per row), instead of only from each group's own card on the Groups page. Admin-only, using the existing per-group member add/remove endpoints.

### Fixed
- The Edit Profile form's Mobile Phone field had a stray `validate=":9"` making it effectively required (submission was blocked with "Please fix the form errors" if left blank) -- it was always meant to be optional, matching the "Add user" form. Removed.
- A service account's profile always showed `Name: Service Account` -- every service account has the same literal filler given/last name (a schema-satisfying placeholder, not meant to be shown), making them indistinguishable by name. The Name line is now hidden for service accounts.
- The Users page's Service Accounts tab, and a freshly-created service account's own profile, could appear empty/not-a-service-account for up to 5 minutes right after creation. Creating a user caches it via `User.get()` *before* the route handler marks it as a service account (group membership), so the cached copy had `isServiceAccount` stuck wrong until the cache TTL expired. Now cleared and re-fetched immediately after marking.
- A user belonging to exactly one LDAP group had their `memberOf` attribute returned as a bare string instead of a one-element array (ldapts's normal behavior for single-valued attributes) -- client-side permission checks (`for(let group of user.memberOf)`) would then iterate the DN character-by-character instead of once, causing pages gated on that group (e.g. Groups) to incorrectly show "You do not have permission to be here." Normalized `memberOf` to always be an array, same fix already applied to `manager`.

## [1.1.7] - 2026-07-17

### Changed
- **Service accounts unified to one kind.** Removed the LDAP bind-only service account type (the Integrations → LDAP "Service Accounts" card, and its `/api/service-account` routes) -- every service account is now a real Unix/POSIX account with a UID, created from the new **Users → Service Accounts** tab. Email and password are both optional for service accounts; a blank password means no `userPassword` is set at all (the account simply can't bind).
- **Added a `manager` field to every account.** Multi-valued (a list of usernames), defaults to whoever created the account (the admin who added it, or whoever sent the invite), and reassignable from the account's Edit form. Anyone listed as a manager can edit that account -- same fields an admin can (mobile, description, SSH key, date of birth, home directory, login shell, manager list) -- without needing `app_sso_admin`.
- `homeDirectory` and `loginShell` are now editable from the Edit Profile form (previously view-only).

## [1.1.6] - 2026-07-16

### Changed
- Redesigned the GitHub Pages docs site to match the app's own look (dark navbar/footer, Bootstrap 5, Font Awesome) instead of the generic `jekyll-theme-cayman` theme, added a real cross-page nav, SEO (`jekyll-seo-tag` + `jekyll-sitemap`, per-page descriptions, OG/Twitter tags, sitemap.xml, robots.txt), and mobile-responsive layout.

## [1.1.5] - 2026-07-16

### Fixed
- Bumped `jq-repeat` 2.0.1 -> 2.1.0. `update()` is now trailing-edge throttled (~50ms) even on the first call; `profile.ejs`'s edit-profile flow updated a scope and immediately slid the same element into view, which could briefly show stale/empty data. Deferred the slide by 60ms.

## [1.1.4] - 2026-07-16

### Added
- **CI**: GitHub Actions now builds the real bundled image, seeds LDAP fixtures, and runs the full Jest suite on every PR (Node 18/20/22) -- this repo had unit tests but nothing ran them automatically until now.
- **White-label**: `<title>`, the navbar brand text, and the favicon were hardcoded "SSO - Theta 42"/"SSO Manager" despite `conf.name` already existing (it was never actually rendered). New `conf.logo` key added alongside it. Footer attribution is left as-is. Closes [#6](https://github.com/theta42/sso-manager-node/issues/6).

### Fixed
- The bundled default ppolicy entry set `pwdLockout: FALSE`, silently making the admin "deactivate user" action not actually block that user's login. Fixed to `TRUE`, with a drift-correction path in `ops/ldap-setup.sh` for already-deployed instances. A separate, deeper ppolicy-overlay issue remains open as [#68](https://github.com/theta42/sso-manager-node/issues/68).
- `top.ejs` referenced a `/static/favicon.svg` that didn't exist in `public/` (a pre-existing 404) -- now uses the existing logo file via `conf.logo`.

## [1.1.3] - 2026-07-16

### Added
- `CHANGELOG.md` (this file), backfilled from the release notes for every tag so far and served in-app at `/docs/changelog`. Closes [theta-env#43](https://github.com/theta42/theta-env/issues/43).

## [1.1.2] - 2026-07-16

### Fixed
- Removed a dead IE<9-only `html5shim` script tag pointing at a domain that no longer resolves.

### Added
- **In-app documentation**: `GET /docs` and `GET /docs/:slug` render this project's own README, DEPLOYMENT, API.md, `docs/{ldap,oauth,configuration}.md`, and `directory_spec.md` server-side — readable from the running app with no dependency on GitHub Pages, which requires internet access to view. Public, no auth, rate-limited.

## [1.1.1] - 2026-07-16

### Added
- **Terms of Service is now editable at runtime by admins.** `tos.md` used to be baked into the repo and read once at startup, requiring a code change and deploy to update. It's now a Redis-backed singleton, editable from a new "Terms of Service" card on the admin Dashboard, with the bundled `tos.md` used only as a one-time seed for new deployments. Admins can optionally require all users to re-accept the terms after a substantive edit. Closes [#39](https://github.com/theta42/sso-manager-node/issues/39). ([#62](https://github.com/theta42/sso-manager-node/pull/62))

## [1.1.0] - 2026-07-16

First tagged release. Establishes the `vX.Y.Z` tag convention that the in-app update-check banner polls against going forward.

### Added
- Standalone backup script (`ops/backup.sh`) — snapshots LDAP (`slapcat`), Redis, and `./config`, with retention.
- Admin-only in-app banner that checks GitHub releases every 24h and surfaces available updates.
- Unix/POSIX and LDAP bind-only service account support, distinct from real-person accounts.
- Merged OAuth Apps + LDAP Info into a single Integrations page.

## [Unreleased]

## [1.14.0] - 2026-08-01

### Added
- Added Configuration page in the UI to manage SSO configurations stored securely in OpenBao Vault.
- Added Discovery plugin and Scheduler integration within the Directory.
- Re-routed Vault proxy under `/api/vault` and implemented Vault authentication headers.

[Unreleased]: https://github.com/theta42/sso-manager-node/compare/v1.1.16...HEAD
[1.1.15]: https://github.com/theta42/sso-manager-node/compare/v1.1.14...v1.1.15
[1.1.14]: https://github.com/theta42/sso-manager-node/compare/v1.1.13...v1.1.14
[1.1.13]: https://github.com/theta42/sso-manager-node/compare/v1.1.12...v1.1.13
[1.1.12]: https://github.com/theta42/sso-manager-node/compare/v1.1.11...v1.1.12
[1.1.11]: https://github.com/theta42/sso-manager-node/compare/v1.1.10...v1.1.11
[1.1.10]: https://github.com/theta42/sso-manager-node/compare/v1.1.9...v1.1.10
[1.1.9]: https://github.com/theta42/sso-manager-node/compare/v1.1.8...v1.1.9
[1.1.8]: https://github.com/theta42/sso-manager-node/compare/v1.1.7...v1.1.8
[1.1.7]: https://github.com/theta42/sso-manager-node/compare/v1.1.6...v1.1.7
[1.1.6]: https://github.com/theta42/sso-manager-node/compare/v1.1.5...v1.1.6
[1.1.5]: https://github.com/theta42/sso-manager-node/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/theta42/sso-manager-node/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/theta42/sso-manager-node/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/theta42/sso-manager-node/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/theta42/sso-manager-node/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/theta42/sso-manager-node/releases/tag/v1.1.0

## [1.19.6] - 2026-08-02
### Fixed
- Fixed Vault API returning 403 on the Secrets List due to `http-proxy-middleware` v2 rewriting the path incorrectly (it previously appended the `/api/vault/` mount path to the proxied Vault request).
