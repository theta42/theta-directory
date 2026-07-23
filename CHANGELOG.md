# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
correspond to git tags (`vX.Y.Z`) and `nodejs/package.json`'s `version`.

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
