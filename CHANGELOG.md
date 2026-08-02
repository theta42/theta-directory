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
