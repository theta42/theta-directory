# Home-Lab Directory / Inventory — Design Spec

Status: **Draft / agreed direction** (no code yet)
Owner: wmantly
Last updated: 2026-07-02

---

## 1. Overview & goals

The SSO app manages LDAP groups that gate access across the home lab:

- `app_*` — applications (Home Assistant, Gitea, Emby, …)
- `host_*` — machines (Proxmox nodes, LXC containers, VMs, bare metal)

A bootstrap script joins each Debian container to LDAP and grants SSH by group
membership. Access control works — but the groups are **bare**. In LDAP a group
(`models/group_ldap.js`) only carries `cn`, `description`, `member`, `owner`.
There is:

- **No metadata** — no URL, IP, FQDN, port, icon, or notes per app/host.
- **No relationships** — nothing links a **Proxmox host → the container running on
  it → the service the container provides → the LDAP group that gates access**.

Consequences:

- **Users can't see what they have access to or how to reach it.** Today
  `views/profile.ejs` hardcodes a static "Services" list (Emby, Git, Proxmox…)
  with fixed URLs that are unrelated to the viewer's actual group membership.
- **CI/CD and service discovery have no source of truth.** Pipelines and tooling
  can't answer "which host runs service X", "what's the IP of `host_ct101`", or
  "which group grants access to this".

### Goals

1. A machine-readable **discovery API** (build this first) that exposes apps/hosts,
   their metadata, and the infra graph — for CI/CD, dynamic inventory, and dashboards.
2. Answer, per user, **"what can I access and how do I reach it"** (later dashboard,
   powered by the same API).
3. Model the **full graph**: Proxmox host ← container/VM ← service/app.

### Non-goals (v1)

- No write/admin UI yet (management comes in a later phase).
- No auto-provisioning/sync from Proxmox yet (manual population first).
- No change to how access is granted — **LDAP remains the access-control truth.**

---

## 2. Architecture

Two stores, one join key.

```
            ┌──────────────────────────────────────────────┐
            │                 SSO app (this repo)           │
            │                                               │
  Identity  │   LDAP  ──────────────►  access-control truth │
  & access  │   (users, app_*/host_* groups, membership)    │
            │        │                                      │
            │        │  join on group cn                    │
            │        ▼                                      │
  Inventory │   SQL  ──────────────►  metadata + graph      │
            │   (resources, edges, resource↔group links)    │
            │        │                                      │
            │        ▼                                      │
            │   /api/discovery/*  (read-first API)          │
            └──────────────────────────────────────────────┘
```

- **LDAP = access truth.** Who is in `app_homeassistant` / `host_ct101` stays in
  LDAP, unchanged. Read via `Group.list(user.dn)` (`models/group_ldap.js`).
- **SQL = inventory truth.** Metadata and the host→container→service graph.
- **Join key = group `cn`.** A SQL resource references the LDAP group(s) that gate
  it by name (`app_*` / `host_*`). "Who can access resource X" is a join:
  LDAP membership ∩ `resource_group`.

### Tech choice (to confirm)

- **PostgreSQL** recommended (JSONB for flexible metadata, real relational edges).
  **SQLite** is a lighter alternative acceptable for a single-node home lab.
- Thin query layer: `node-postgres` (`pg`) directly, or `knex` for migrations +
  query building. This is the app's **first SQL dependency** (today it uses LDAP +
  Redis via `model-redis`); the directory is a self-contained module and should not
  disturb the existing stores.

---

## 3. Data model (full graph)

Three tables. Metadata is a JSONB bag so fields can evolve without migrations;
common query fields can be promoted to columns later.

### `resource` — a node in the graph
| column       | type        | notes |
|--------------|-------------|-------|
| `id`         | uuid / pk   | |
| `kind`       | enum        | `site` \| `host` \| `service` |
| `name`       | text        | display name ("Home Assistant", "ct101") |
| `slug`       | text unique | url-safe id used by the API |
| `description`| text        | free text |
| `metadata`   | jsonb       | `{ subType, ip, macAddress, address, vmid, port, externalPort, gitRepo, installPath, systemdService, os, kernel, isProduction, isExternalReachable, isPublic }` |
| `created_at` / `updated_at` | timestamptz | |

**Parent Enforcement Rules:**
- A **Host** MUST have a parent **Site** or **Host**.
- A **Service** MUST have a parent **Host**.
- An **OAuth Integration** MUST have a parent **Service**.

**LDAP Group Auto-Creation:**
When a Host or Service is created, the system will automatically create two LDAP groups in the directory (if they do not already exist): 
- `<slug>_access` (for standard user access)
- `<slug>_admin` (for administrative access)
Additional groups can still be linked manually.

### `resource_edge` — directed relationships (the graph)
| column       | type   | notes |
|--------------|--------|-------|
| `parent_id`  | fk → resource | |
| `child_id`   | fk → resource | |
| `relation`   | enum   | `runs_on` \| `hosts` \| `exposes` \| `depends_on` |

Represents site←host←service (`hosts`/`runs_on`) and service→service
(`depends_on`). Directed edges (not a single `parent_id` column) so a node can have
multiple parents/children and multiple relation types.

### `resource_group` — link a resource to the LDAP group(s) that gate it
| column        | type   | notes |
|---------------|--------|-------|
| `resource_id` | fk → resource | |
| `group_cn`    | text   | LDAP group name, `app_*` / `host_*` |
| `access_level`| enum   | `user` \| `admin` \| `owner` |

This is the bridge to auth. It lets one resource be gated by several groups
(e.g. `app_gitea` for users, `host_ct_gitea` for shell/admin).

**Naming:** the `app_*` / `host_*` prefix convention is retained in LDAP; in SQL the
distinction is captured explicitly by `resource.kind` + `resource_group`, so the API
never has to parse group-name prefixes.

### Example
```
resource: pve1 (proxmox_node)  ── hosts ──▶  ct101 (container)  ── exposes ──▶  gitea (service)
                                                                                   │
resource_group: gitea ↔ app_gitea (user), ct101 ↔ host_ct101 (user), pve1 ↔ host_pve1 (admin)
```
A user in `app_gitea` sees the Gitea service + how to reach it; a user in
`host_ct101` additionally sees SSH to the container; `host_pve1` sees the node.

---

## 4. Discovery API (v1 — read-first)

JSON. Mounted at `/api/discovery` behind `middleware.auth` (see §5).

| method & path | purpose |
|---------------|---------|
| `GET /api/discovery/resources?kind=&tag=&group=&parent=` | Filtered list of nodes + metadata. |
| `GET /api/discovery/resources/:slug` | One node with its edges (parents + children). |
| `GET /api/discovery/graph[?root=<slug>]` | Whole graph, or the subtree under a root. |
| `GET /api/discovery/me` | Only the resources the **caller** is entitled to — LDAP membership (`Group.list(user.dn)`) ∩ `resource_group`. Powers the future dashboard and the "what can I access" question. |

### CI/CD-friendly output (optional formats, same data)
- **Ansible dynamic inventory** shape (`?format=ansible`): groups of hosts with
  `ansible_host`/vars pulled from `metadata`.
- **Dashboard** shape (Homepage/Glance): flat list of services with `href`, `icon`,
  `description`.

Write endpoints (POST/PUT/DELETE) are **out of scope for v1**; population is manual
(SQL seed / migration) until the admin UI phase.

---

## 5. AuthN / AuthZ

- **Interactive users:** existing session auth — `middleware.auth` validating the
  `auth-token` header (an `AuthToken`, `models/token.js`). No change.
- **CI/CD (machine) access:** scripts and external integrations (like jump hosts) will use the existing `ApiToken` system (Personal Access Tokens) passed in the `Authorization: Bearer sso_...` header. The `ApiToken` inherits the exact LDAP group permissions of the user who created it, seamlessly mapping to existing access controls.
- **Read visibility (decision to confirm):** either (a) any authenticated user may
  read all resource metadata and only `/me` is filtered, or (b) list endpoints are
  themselves filtered to entitlement. Recommend **(a)** for a home lab — simpler,
  and infra metadata isn't secret — with `/me` as the personalized view.
- **Management (later):** gate write/admin endpoints behind a new
  `app_sso_directory_admin` LDAP group, mirroring the existing
  `app_sso_oauth_admin` pattern (`routes/oauth_client.js` + `utils/permission.js`).

---

## 6. Integration points with the existing app

- **Replace the hardcoded Services list** in `views/profile.ejs` (lines ~82–126)
  with a render of `GET /api/discovery/me`.
- **Reuse the group selector** `app.ui.groupSelect` (`public/js/app.js`) for linking
  resources ↔ LDAP groups in the future admin UI — no new group-picker needed.
- **Join convention:** `resource_group.group_cn` must equal an LDAP group `cn`
  exactly; the discovery layer never invents groups, it only references existing ones.
- **Reuse `utils/permission.byGroup`** for the admin gate in the management phase.

---

## 7. Roadmap

1. **v1 — Discovery API** (this spec's focus): SQL schema + migrations, read models,
   `/api/discovery/*` endpoints, `ApiToken` for CI/CD.
2. **v2 — "My Access" dashboard**: swap `profile.ejs`'s static list for `/me`.
3. **v3 — Admin CRUD UI**: manage resources/edges/group links (reusing `app.ui`
   widgets and the `oauth_clients.ejs` card+modal pattern); gated by
   `app_sso_directory_admin`.
4. **v4 — Sync from Proxmox** (optional): auto-populate nodes/containers/VMs from the
   Proxmox API so inventory stays current without manual entry.

---

## 8. Open questions

1. **DB engine:** PostgreSQL (recommended) vs SQLite for a single-node lab.
2. **Population:** manual seed vs Proxmox pull for v1 (spec assumes manual).
3. **Metadata mirroring:** should any metadata be written back to the LDAP group
   `description` so LDAP-only external consumers see it? **Default: no** — keep LDAP
   for auth, SQL for inventory.
4. **Read-visibility policy:** confirm option (a) vs (b) in §5.
5. **Service token scope:** Currently `ApiToken` shares the creator's full permissions. A future enhancement could scope tokens specifically to the Directory API.
