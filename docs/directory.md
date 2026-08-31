---
layout: default
title: Directory Management
description: Managing your Home-Lab infrastructure, services, and LDAP access relationships via the SSO Directory API.
---

# Directory Management

The SSO Manager ships with a built-in **Directory & Inventory Management** feature. Instead of just managing bare LDAP groups for your homelab, the Directory allows you to map out your infrastructure graph and assign rich metadata to your services.

## Architecture

The Directory models your homelab infrastructure using a parent-child graph (e.g. `Site -> Host -> Service`).

There are three primary **Kinds** of resources you can define:
- **Site**: A physical location, datacenter, or root node (e.g., `us-east`). Sites do not require parents.
- **Host**: A physical machine, Proxmox node, virtual machine, or LXC container. A Host **must** have a parent Site or another Host.
- **Service (App)**: An application, web service. A Service **must** have a parent Host or another Service.
- **OAuth Integration**: An OAuth 2.0 / OpenID Connect client application. An OAuth integration **must** have a parent Service.

By defining this hierarchy, the SSO Manager builds a queryable graph of your infrastructure.

## Automatic LDAP Group Creation

When you create a new **Host** or **Service** in the Directory via the web UI (or API), the SSO Manager will automatically provision two LDAP groups in your directory to govern access to that resource:

1. `<slug>_access` (Member level access)
2. `<slug>_admin` (Owner level access)

For example, if you create a Service named "Emby" with the slug `app_emby`, the system will create the LDAP groups `app_emby_access` and `app_emby_admin`. You can then assign users to these groups, and they will immediately see the service populate on their "My Services" dashboard.

### Two exceptions, by design

**A service registered by theta-agent gets no groups of its own.** When you run
`theta-agent register systemd emby-server` on a host, the Directory creates a
`service` resource under that host — but a systemd unit is not an access
boundary. Whoever administers the machine administers its units. One
`svc-<host>-systemd-<unit>_access` pair per unit per host is sprawl with no
decision behind it, so these resources inherit access from the host that runs
them instead, and the Directory hides the **Associated LDAP Groups** tab for
them. Their Access column reads *via host*.

This applies only to services an **agent** registered. A service resource you
created by hand — the stack's own `sso-manager-<site>`, an OAuth-linked app —
is something you chose to model, and keeps its groups.

**A host running theta-agent is reachable without a per-host grant**, for users
whose groups already cover hosts at that site (`god_admin`,
`{site}_super_admin`, or the `{site}_hosts_access` / `{site}_hosts_admin`
aggregate — see [groups](groups.html)). Installing the agent requires root on
the machine *and* a join key from this Directory, so it is already under
management. The `<slug>_access` / `<slug>_admin` groups are still created and
still work for granting access to anyone else.

Access does not outlive the enrolment: revoking or deleting an agent clears the
binding and removes the host from every access projection immediately.

## Resource Metadata & Dynamic Schemas

Resources carry a flexible `metadata` JSON object that stores context for your applications. Rather than cluttering every resource with hardcoded fields, the Directory renders fields **dynamically based on the selected Subtype Template** (e.g. `web`, `systemd`, `docker`, `ssh`, `git-repo`, `lxc`, `vm`).

### Optional Names and Slugs
- **Name**: Optional. If omitted, defaults sensibly based on the resource subtype and kind (e.g. `Lxc host`, `Ssh service`).
- **Slug**: Optional. Auto-derived from the name or kind with automatic collision resistance (e.g. `app_custom_portal_1a2b3c`).

### Dynamic Subtype Schemas
Each subtype template specifies the exact fields it needs on the **Details** tab:
- **Web Application (`web`)**: Internal Port, External Port, Base / Public URL, Reachable Externally, Public (No Auth), Git Repo, Install Path, Systemd Unit.
- **Systemd Service (`systemd`)**: Systemd Unit Name (e.g. `nginx.service`), Listening Port, Working Directory / Install Path.
- **SSH Service (`ssh`)**: SSH Listening Port (default 22), Systemd Unit Name (`sshd.service`).
- **Docker / Podman Container (`docker`, `podman`)**: Container Name, Image, Mapped Host Port.
- **Git Repository App (`git-repo`)**: Git Repository URL, Branch (`main`), Install Path (`/opt/...`), Systemd Service.
- **Port Forward (`port-forward`)**: Target Internal Port, Source External Port, Protocol (`tcp`/`udp`), Reachable Externally.
- **Hypervisors & Guests (`proxmox`, `lxc`, `vm`)**: Cores, Total RAM, Total Disk, VMID, Node, Power State, Network Interfaces, and Tags.

## Live Status, Monitoring & Parent Rollups

1. **SSH Service Monitoring**:
   - For `subType: 'ssh'`, the Directory actively evaluates the SSH daemon. If `theta-agent` is enrolled on the host, it monitors the `sshd.service` unit. If monitored remotely without an agent, it executes non-blocking TCP connectivity and protocol banner probing.
2. **Proxmox Guest Controls & Live Stats**:
   - For `lxc` containers and `vm` guests discovered via Proxmox, operators can view real-time CPU, RAM, Disk, and Uptime metrics, and trigger power actions directly from the resource modal (`Start`, `Stop`, `Reboot`, `Shutdown`).
3. **Parent Status & Workload Rollup**:
   - When viewing any Host or Site modal, all child workloads, services, VMs, and containers roll up into a unified **Child Workloads & Status Rollup** dashboard, showing aggregate health tallies (Healthy / Warning / Critical / Unknown), child network addresses, and quick click-through navigation.

### Who sees which metadata

Metadata keys are declared in `@simpleworkjs/directory-schema` with an `admin` flag, and every API response is passed through its projection. There are three tiers:

- **Public** — returned to any authenticated caller, including machine (`ServiceToken`) callers: `ip`, `address`, `sshPort`, `fqdn`, `dnsNames`, `port`, `externalPort`, `portMappings`, `isExternalReachable`, `os`, `gitRepo`, `subType`, `icon`, `tagline`, `isPublic`, `isProduction`, `requestable`, `isCurrentSite`.
- **Admin-only** — only for members of `app_sso_directory_admin` / `app_sso_admin`: `vmid`, `macAddress`, `installPath`, `systemdService`, and the OAuth config keys (`redirect_uris`, `scopes`, `allowed_groups`, `token_lifetime`).
- **Never returned** — `client_secret_hash`, plus any key matching `/secret|password|privatekey/i`. Stripped on every path, admins included.

Note that machine tokens are deliberately *not* admins, so anything a machine consumer needs (the firewall generator reads `port` / `externalPort` / `isExternalReachable`) has to be in the public tier. A metadata key that isn't declared at all is treated as admin-only and will silently vanish for normal users — if you add a field to the admin form, declare it in the schema package too.

## Catalog & access requests

The site root (`/`) is the end-user catalog — the only ungated page in the nav. It shows:

- **My Access** — everything the signed-in user can reach (`GET /api/discovery/me`), each card carrying a **how to reach it** block: the URL for a service, or the SSH invocation for a host. When `directory.jumpHost` is set in the config, host cards render the jump-host form `ssh <uid>_-_<slug>@<jumpHost>`; otherwise they fall back to a direct `ssh <uid>@<ip>`.
- **Discover More** — everything else in the directory, with a **Request access** button.
- **My Requests** / **Awaiting My Approval** — pending requests, and the approve/deny queue for anyone who owns a requested resource.

A request is a proposal to join an LDAP group. It targets the resource's `member`-level group (the `_access` one, never `_admin`), and approving it performs the LDAP group add — so LDAP stays the single access-control truth and the table is just the audit trail. Approvals are idempotent: approving for someone already in the group succeeds rather than erroring.

Requests are decided by the resource's `owner`, or by any directory admin. Mark a resource `metadata.requestable = false` to keep it out of self-service.

## Navigating the UI

The Directory Management interface nests your resources as a tree, making it easy
to comprehend your network topography at a glance. You can filter, search, and
sort your entire infrastructure inventory. Click the green `+` icon next to any
resource to add a child resource beneath it.

**Collapsing the tree.** Any resource with children carries a caret; click it to
fold that subtree away. The toolbar's double-chevron buttons expand or collapse
everything at once. Collapsed state is remembered per browser, so the shape you
arrange survives a refresh (and the self-heal reload that follows most edits).

While a search filter is active every match is shown regardless of collapsed
ancestors — otherwise searching for something inside a folded subtree would
silently return nothing. Clearing the box restores your saved shape.

<a href="images/directory.png" target="_blank"><img src="images/directory.png" alt="Directory & inventory list view" width="80%"></a>

### Live status and control

Hosts carry a coloured dot in the tree for their agent (green healthy, amber
high load, red enrolled-but-offline, grey no agent). **Services registered by an
agent carry the same dot for the service itself**: green active, red inactive,
grey when the host agent is offline or has not reported the service yet, and a
darker grey when the unit is no longer present on the host at all. A service's
state is only as current as the agent reporting it, so an offline agent greys
the service out rather than leaving a stale green.

Opening a registered service shows **Live status & metrics** — sub-state, CPU,
memory, restart count, uptime, and for timers and cron entries the next/last run
— plus **Start / Restart / Stop** (and **Reload** for systemd units). The
buttons dispatch over the agent's signed command channel; `stop` and `restart`
are confirmed first and marked high-risk, `start` is not. They are disabled with
the reason in the tooltip when the agent is not connected, rather than appearing
and vanishing as it reconnects.

Only subtypes with a real lifecycle are offered controls: `systemd`, `docker`,
`podman`, `openrc`. A timer, a cron entry or a VM has no `systemctl start`, so
no button is shown rather than one that can only fail.

## Slug conventions

Slugs are the stable identifiers automation keys off, so the tooling around the SSO Manager follows a shared convention:

- **Sites**: `site_<name>` — e.g. `site_local`, `site_us-east`
- **Hosts**: `host_<hostname>` — e.g. `host_pve1`, `host_web01`
- **Services/apps**: a plain slug or `app_<name>` — e.g. `sso-manager`, `app_emby`

The auto-created LDAP groups derive from the slug (`<slug>_access` / `<slug>_admin`), so keep slugs stable once access groups are in use.

## Automatic registration

You don't have to build the graph by hand — the theta42 tooling registers itself:

### The stack itself (theta-env)

[theta-env](https://github.com/theta42/theta-env)'s `./setup.sh` seeds the directory on every run with the stack it deploys:

- a **site** (name from `CFG_SITE_NAME` in `setup.env`, default `local` → slug `site_local`) marked as the current site
- the **host** the stack runs on (`host_<hostname>`), with IP, MAC address, OS, and kernel collected from the machine
- the **hosts** for the proxy and jump host (`host_theta-proxy`, `host_theta-jump`)
- the **services** it composes — SSO Manager, Proxy (management UI), OpenLDAP Directory (the LDAPS endpoint Linux hosts and LDAP-native apps bind to), OpenResty Edge (the 80/443 data plane), and the SSH Jump Host — each with its address, internal port, and git repo
- the proxy's auto-registered **OAuth client**, linked under its service

Services are parented to the host that actually runs them: Proxy and OpenResty
Edge under `host_theta-proxy`, the SSH Jump Host under `host_theta-jump`, and the
rest under the stack host. Installs seeded before this was fixed had all of them
under the stack host, leaving the two purpose-made host resources childless; the
seed re-parents those on its next run, and only when the current parent is the
one the old code set, so a layout you arranged deliberately is left alone.

The seed is idempotent and non-destructive: a resource whose slug already exists is considered operator-owned — the seed only fills in metadata fields you haven't set, and never overwrites your values.

### Linux hosts (ldap-client)

The `ldap-client` join script enrolls a Debian/Ubuntu machine for LDAP login (SSSD/PAM), LDAP-backed `sudo`, and SSH keys from the directory — and, when given an SSO API token, registers the machine as a `host_<hostname>` resource with its IP, MAC, OS, and kernel, parented to the site named by its configured location.

## Consumers of the directory

The inventory graph isn't just documentation — other components read it to make decisions:

- **[Jump Host](https://theta42.github.io/jump-host/)** — an SSH jump host that resolves which downstream machines a user may reach from their LDAP groups × the directory's `host` resources (`GET /api/discovery/resources?group=<cn>`), then bridges them in. The `host_<hostname>` slugs and `host_<slug>_access` groups this directory creates are exactly what it keys off; a host's `metadata.ip` / `metadata.sshPort` tell it where to connect. So a machine registered here (by theta-env or ldap-client) becomes reachable through the jump host the moment a user is in its access group.

Planned consumers (end-user catalog, firewall/DNS generation) and the model/API gaps they need are tracked in [`directory_spec.md`](https://github.com/theta42/sso-manager-node/blob/master/directory_spec.md) §9.

## Subtype Management & Metrics Drivers Architecture

The Directory includes a **4-tier Driver Resolution Engine** (`services/driver_registry.js`) that binds a resource's `subType` metadata to specific operational protocols for real-time telemetry, log streaming, and remote lifecycle management:

1. **Direct Agent Execution** (`ThetaAgentDriver`): Used when a `theta-agent` daemon is connected to the resource (`systemd`, `docker`, `zfs_pool`, `desktop_linux`, `openrc`, `wireguard`).
2. **Specialized Subtype Drivers**:
   - `ProxmoxDriver`: Proxmox VE hypervisors & `lxc` / `kvm` guest controls.
   - `DockerSocketDriver`: Docker Engine API & `docker_compose` stacks.
   - `DbDriver`: `postgresql`, `redis`, `openbao_vault`.
   - `NetworkDriver`: `wireguard`, `unifi_ap`, `unifi_switch`, `pfsense`.
   - `K8sDriver`: `k8s_pod`, `k8s_deployment`.
3. **Ancestor / Hypervisor Provider Fallback**: If an LXC/KVM guest lacks a direct agent, the engine automatically queries its parent Proxmox hypervisor node for VMID telemetry and power controls.
4. **Unmanaged Fallback**: Reports unmanaged status cleanly.

### Subtype Operations API
- `GET /api/directory-admin/resources/:id/driver-metrics` — Real-time telemetry payload
- `POST /api/directory-admin/resources/:id/driver-action` — Execute management actions (`{ action, params }`)
- `GET /api/directory-admin/resources/:id/driver-logs` — Tail operational log output (`?lines=100`)

## Explicit Secret Inheritance Mode

Resource secrets stored in OpenBao (`secret/data/resources/<slug>/conf`) use **Explicit Secret Inheritance Mode** with strict upward ancestor lineage:

- **Strict Ancestor Lineage**: When viewing candidate secrets for inheritance, the dropdown strictly filters to **direct upward ancestors** in the directory hierarchy (Resource $\rightarrow$ Parent Host $\rightarrow$ Cluster $\rightarrow$ Site). Sibling resources across the directory are never exposed.
- **Explicit Assignment**: Secret pointers (`INHERIT:<parentSlug>:<parentKey>`) are explicitly saved per resource, guaranteeing precise secret scoping across hosts, LXC/KVM containers, and services.

## API

All of the above uses the same admin API the UI does (group `app_sso_directory_admin` or `app_sso_admin`):

- `GET/POST /api/directory-admin/resources`, `PUT/DELETE /api/directory-admin/resources/:id`
- `GET/POST/DELETE /api/directory-admin/edges` — parent/child links (`hosts`, `oauth` relations)
- `GET/POST/DELETE /api/directory-admin/groups` — resource ↔ LDAP group links
- `GET /api/directory-admin/access-summary` — per-resource group + member counts (the Access column)
- `GET /api/directory-admin/user-access/:uid` — the reverse lookup: every resource a given user can reach, and via which group
- Read-only graph views (any authenticated user): `GET /api/discovery/resources`, `/api/discovery/resources/:slug`, `/api/discovery/graph`, `/api/discovery/me`

Access requests are open to any authenticated user; deciding is gated per-resource inside the router (resource owner or directory admin):

- `POST /api/access-requests` — `{slug | resourceId, groupCn?, note?}`
- `GET /api/access-requests/mine` — the caller's own history
- `GET /api/access-requests` — pending requests the caller may decide
- `POST /api/access-requests/:id/approve` · `POST /api/access-requests/:id/deny`
- `DELETE /api/access-requests/:id` — the requester withdraws their own pending request
