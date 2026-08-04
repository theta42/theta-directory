---
layout: default
title: Group & Permission Model
nav_order: 3
---

# Theta42 Group & Permission Model

This is the canonical reference for how **groups and permissions work** across the
theta42 suite (SSO Manager, Proxy, Jump-Host) and how **downstream apps and Linux
hosts** should read and use them. It is written to be implementable by both humans
and LLM agents.

Everything below assumes LDAP is the single source of truth for identity and group
membership. Group membership is managed in the **SSO Manager Directory**, generated
from adopted resources — there is **no standalone "Groups" page**.

---

## 1. Principles

1. **Groups are a projection of the resource graph.** Every adopted host and app
   in the Directory gets its own groups, auto-created from its identity. Group
   membership is managed on the resource's modal.
2. **Two orthogonal resource namespaces: `host` and `app`.** A host administers
   hosts; an app administers apps. They do not inherit from each other.
3. **Three levels per resource: `admin`, `access`, and opaque `capability`.**
   `admin` implies `access`. Capabilities are explicit and never implied by
   `admin`.
4. **Multi-site by prefix.** Each site's groups are fully independent, scoped by
   the site slug.
5. **Hosts map, LDAP stays clean.** Directory groups are `groupOfNames` (RBAC)
   with **no `gidNumber`**. A Linux host uses SSSD to import only the groups it
   needs and generate their GIDs on the fly (see §8) — no mass import, no GID
   bloat. Only the meta groups are never imported by hosts.
6. **The directory is the only place groups are created.** `god_admin` is the sole
   group that does not belong to a resource or site.

---

## 2. Group schema

`S` = site slug (see §7 for normalization). `<host>`/`<app>` = the resource slug.
`<capability>` = an opaque, app-defined capability token (see §4).

| Group | Scope | Meaning |
| :--- | :--- | :--- |
| `god_admin` | global | **Everything, everywhere** (all sites, hosts, apps, consoles, all capabilities). The only non-site group. |
| `S_super_admin` | site | Everything on site `S` (all hosts, apps, consoles, all capabilities at `S`). |
| `S_hosts_admin` | site | Admin on **all hosts** at `S`. |
| `S_hosts_access` | site | Access to **all hosts** at `S`. |
| `S_hosts_<capability>` | site | Capability `<capability>` on **all hosts** at `S`. |
| `S_host_<host>_admin` | host | Admin on host `<host>`. |
| `S_host_<host>_access` | host | Access to host `<host>`. |
| `S_host_<host>_<capability>` | host | Capability `<capability>` on host `<host>`. |
| `S_apps_admin` | site | Admin on **all apps** at `S`. |
| `S_apps_access` | site | Access to **all apps** at `S`. |
| `S_apps_<capability>` | site | Capability `<capability>` on **all apps** at `S`. |
| `S_app_<app>_admin` | app | Admin on app `<app>`. |
| `S_app_<app>_access` | app | Access to app `<app>`. |
| `S_app_<app>_<capability>` | app | Capability `<capability>` on app `<app>`. |

### Meta groups (implicit membership — not POSIX, no gidNumber)

| Group | Scope | Meaning |
| :--- | :--- | :--- |
| `everyone` | global | **All authenticated users**, any site. |
| `S_everyone` | site | **All authenticated users** at site `S`. |

These are resolved by the directory (any authenticated user passes), never
enumerated as LDAP members, and cannot be used as Unix groups.

---

## 3. Naming, normalization & reserved rules

- The **structural delimiter is `_`**. It appears only between the fixed segments
  of a group name.
- **Site, host, and app slugs never contain `_`.** Normalize to lowercase;
  spaces and `_` → `-`; strip other non-`[a-z0-9-]`. A host named `Web 01` and a
  site `Main Office` produce slugs `web-01` and `main-office`.
- **Aggregate groups use the plural kind** (`hosts`, `apps`); per-resource groups
  use the singular (`host`, `app`). This makes `S_hosts_admin` unambiguous even
  if a host were named `admin` (that host would be `S_host_admin_admin`).
- **The last segment is the level.** If it is `admin` or `access` it is a known
  level; any other value is an **opaque capability** owned by a downstream app.
- **Total length budget:** keep a group cn under ~120 chars; reject group
  creation that would exceed it.
- Groups are **`groupOfNames`** (RFC 2307bis) with **no `gidNumber`**. GIDs are
  generated on the host by SSSD for only the groups that host imports (see §8).

---

## 4. Levels and opaque capabilities

- **`admin`** — manage (create/update/delete/config) the resource.
- **`access`** — use/read the resource.
- **`<capability>`** — an arbitrary token the SSO does **not** interpret. The SSO
  manages membership and exposes the group to the app; **the downstream app
  defines and enforces what the capability means** (e.g. `emby_admin`,
  `gitea_maintain`, `reboot`, `backup`).

The directory recognizes `admin`, `access`, `super_admin`, and the meta groups.
Everything else on a resource group is treated as an opaque capability group and
passed through to consumers.

---

## 5. Permission resolution (inheritance)

Define a user's **effective permission** on a resource by checking, from most
specific to most general, whether they are a member of any applicable group. The
rule: a higher group implies everything below it.

### On host `H` at site `S`

| Wanted | Granted if the user is a member of **any** of |
| :--- | :--- |
| **admin** on `H` | `god_admin` · `S_super_admin` · `S_hosts_admin` · `S_host_H_admin` |
| **access** on `H` | (any admin rule above) · `S_hosts_access` · `S_host_H_access` |
| **capability `C`** on `H` | `god_admin` · `S_super_admin` · `S_hosts_C` · `S_host_H_C` |

### On app `A` at site `S`

Identical, with `app`/`apps` substituted for `host`/`hosts`.

### Management console (SSO / Proxy / Jump-Host)

Each console is registered as an **app** on its site, so console admin is:

`god_admin` · `S_super_admin` · `S_app_<console>_admin`

### Pseudocode

```
def effective(resource, level_or_cap, site):
    if user in "god_admin":                  return True
    if user in f"{site}_super_admin":        return True
    if level_or_cap in ("admin","access"):
        agg = f"{site}_{resource.kind}s_{level_or_cap}"
        if user in agg:                      return True
    specific = f"{site}_{resource.kind}_{resource.slug}_{level_or_cap}"
    if user in specific:                     return True
    if level_or_cap == "access":             return effective(resource, "admin", site)
    if level_or_cap == "admin":              return False          # access does not imply admin
    return False
```

`everyone` / `S_everyone` are a special grantee: if a resource grants a group to
`everyone` (or `S_everyone`), any authenticated user (at that site) passes.

---

## 6. Where groups live — the Directory, generated from adopted resources

- There is **no standalone Groups page.** Group creation/management happens on an
  **adopted resource** in the Directory.
- When a host or app is **adopted** (promoted from Discovered Inventory to
  managed), the directory auto-creates its `_admin` and `_access` groups (and
  site aggregates if configured). Capability groups are created on demand.
- Membership (add/remove users) and capability grants are managed on that
  resource's modal.
- Deleting a resource removes its per-resource groups.
- The `S_super_admin`, `S_hosts_*`, `S_apps_*`, `S_everyone` site groups and the
  global `god_admin`/`everyone` are managed at the site level (not on a single
  host/app resource).

---

## 7. Multi-site isolation

One LDAP tree can serve many sites ("Main Office", "Branch Office", "co-lo",
"Mikes Homelab", …). Each site `S` has its own fully independent set of `S_*`
groups behind its prefix. A `main-office_super_admin` or `main-office_hosts_admin`
touches nothing in `branch-office_*` or `steves-homelab_*`. Only `god_admin` and
`everyone` cross site boundaries.

---

## 8. Unix/POSIX groups — mapped on the host, not in LDAP

Directory groups are **`groupOfNames`** (RFC 2307bis) and carry **no `gidNumber`**.
There are hundreds of them and only a handful matter on any given host, so we do
**not** bloat LDAP with GIDs. Instead, each Linux host uses SSSD to import only the
groups it cares about and map them to GIDs **on the fly** (algorithmic ID mapping).
This keeps the directory clean and the per-host surface tiny.

### SSSD — generate GIDs on the fly, import only what you need

```ini
[domain/example]
id_provider = ldap
auth_provider = ldap
ldap_uri = ldaps://ldap.example
ldap_search_base = dc=example,dc=com

# groupOfNames (RFC 2307bis) schema
ldap_schema = rfc2307bis
ldap_group_object_class = groupOfNames
ldap_group_member = member

# Map GIDs mathematically from the LDAP UUID — no gidNumber in LDAP
ldap_id_mapping = true
ldap_group_uuid = entryUUID

# Import ONLY the groups this host needs (e.g. a naming convention or an OU)
ldap_group_search_filter = (&(objectClass=groupOfNames)(cn=linux-*))
```

Key ideas:
- `ldap_id_mapping = true` + `ldap_group_uuid = entryUUID` make SSSD derive a
  stable GID for any group it imports, so **no `gidNumber` attribute is required**
  in LDAP.
- `ldap_group_search_filter` is the gatekeeper: SSSD imports only groups that
  match, discarding the other hundreds. After changing the filter, clear the
  cache (`sss_cache -E`; `rm -f /var/lib/sss/db/*`; restart sssd) and verify with
  `getent group <cn>`.

### What filter to use — the naming convention is the answer

A host should import its **own** resource groups (plus any explicitly granted
ones). Because the schema is predictable, `ldap-client` can generate the per-host
`ldap_group_search_filter` from the enrolled host's identity, e.g. a host `web01`
at site `main-office` imports:

```
(&(objectClass=groupOfNames)(|(cn=main-office_host_web01_access)
                               (cn=main-office_host_web01_admin)
                               (cn=main-office_host_web01_sudo)))
```

So the operator (or ldap-client) selects a small allowlist of the host's `_access`
/ `_admin` / capability groups to feed sudoers, SSH `AllowGroups`, and filesystem
ACLs. **Only those groups are imported** — no GID bloat, no mass import.

### Aliasing an LDAP group into a local group (e.g. `input`)

SSSD cannot merge an LDAP group into a local group whose GID varies per host.
Two host-side mechanisms cover it:

- **pam_exec** — a script in the login stack adds the user to the local group for
  the session:
  ```sh
  #!/bin/bash
  if id -Gn "$PAM_USER" | grep -q "host_input"; then usermod -a -G input "$PAM_USER"; fi
  ```
  `session optional pam_exec.so /usr/local/bin/add_to_input.sh` in
  `/etc/pam.d/common-session`.

- **nss-groupmerge** — merge an LDAP group into a local group at NSS time
  (`/etc/groupmerge.conf`: `input: host_input`, then `group: files sssd groupmerge`
  in `/etc/nsswitch.conf`), so any service querying `input` sees the LDAP group's
  members regardless of the local GID.

### Meta groups

`god_admin`, `everyone`, and `S_everyone` are NOT imported by hosts — they have
implicit membership and are resolved by the directory only.

---

## 9. Downstream-app consumption guide

A downstream app (Emby, Gitea, a custom service, a shell script) reads group
membership from LDAP and interprets it as follows:

1. **Discover the user's groups** — bind with the user's credentials (or use a
   service account + `memberOf`). Groups are `groupOfNames` (member DN), so query
   by the user's DN, e.g. `(&(objectClass=groupOfNames)(member=<user_dn>))`, or use
   the `memberOf` reverse attribute on the user's entry.
2. **Match each group to a scope:**
   - `god_admin` → the user is a global administrator.
   - `{site}_super_admin` → site administrator for that site.
   - `{site}_hosts_*` / `{site}_app_*` (aggregate) → applies to all hosts/apps at the site.
   - `{site}_host_<host>_*` / `{site}_app_<app>_*` → applies to that one resource.
   - `everyone` / `{site}_everyone` → the user is implicitly a member.
3. **Interpret the last segment:**
   - `admin` → full control of that resource.
   - `access` → read/use.
   - anything else → a capability **you** define; act on it or ignore it.
4. A user with `{site}_host_web01_access` can reach `web01`; a user with
   `{site}_host_web01_reboot` (if you define `reboot`) may reboot it; a user with
   `{site}_app_emby_emby_admin` administers Emby.

The app must **never** treat an unknown last segment as `admin` or `access`.

---

## 10. Migration from the legacy `app_*` groups

The current global groups (`app_sso_admin`, `app_super_admin`,
`app_sso_directory_admin`, `app_jump_admin`) are replaced by the new model:

| Legacy | New |
| :--- | :--- |
| `app_super_admin` | `god_admin` |
| `app_sso_admin` | `S_app_sso_admin` (+ `S_super_admin` for site admins) |
| `app_sso_directory_admin` | `S_app_sso_admin` |
| `app_jump_admin` | `S_app_jump_admin` |

During the transition the legacy groups may be kept as short-lived aliases that
resolve to the same effective permission; once everything is moved, remove them.

---

## 11. The management consoles are apps

The SSO, Proxy, and Jump-Host each register themselves as an app on their site and
receive their auto-generated groups (`S_app_sso_admin`, `S_app_proxy_admin`,
`S_app_jump_admin`, plus `_access`). Their admin UIs gate on
`god_admin` · `S_super_admin` · `S_app_<console>_admin`. This keeps everything
self-consistent: the SSO is "just another app."
