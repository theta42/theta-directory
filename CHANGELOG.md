# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
correspond to git tags (`vX.Y.Z`) and `nodejs/package.json`'s `version`.

## [Unreleased]

## [1.1.11] - 2026-07-17

### Changed
- Moved the help (❓) link out of the global header and onto each relevant card individually (Invite User, Add new user, User List, Service Accounts, group cards, OAuth/LDAP integration cards, My groups, Members of `<uid>`'s group, New API Token) — each now deep-links straight to the doc that actually covers it, instead of one generic header icon.

Bumps to v1.1.11.

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

[Unreleased]: https://github.com/theta42/sso-manager-node/compare/v1.1.11...HEAD
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
