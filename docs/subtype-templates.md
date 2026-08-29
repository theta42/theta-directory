---
layout: default
title: Subtype Templates
nav_order: 7
---

# Subtype Templates

[← Back to Home](index.html)

A **subtype** is what a resource *is* — `linux`, `proxmox`, `theta-agent`,
`port-forward`. Subtypes are not hardcoded, because there is no way to know in
advance what people will put in their directory. They are rows in the
`subtypetemplate` table, seeded with a handful of defaults at boot and editable
through `/api/subtype-templates`.

A template answers four questions about every resource carrying its slug:

1. **What kind of node is it?** (`target_kind`)
2. **Where in the tree may it go?** (`valid_parent_types`)
3. **What fields does it have, beyond the ones every resource has?** (`schema`)
4. **What does "healthy" mean for it?** (`status_rules` — see
   [Status Rules](status-rules.html))

## Shape

```json
{
  "slug": "port-forward",
  "name": "Port Forward",
  "target_kind": "service",
  "valid_parent_types": ["host"],
  "icon": "mdi-router-wireless",
  "schema": {
    "properties": {
      "targetPort": { "type": "number",  "description": "Internal Port" },
      "sourcePort": { "type": "number",  "description": "External Port" },
      "protocol":   { "type": "string",  "enum": ["tcp", "udp"] },
      "isExternalReachable": { "type": "boolean", "description": "Reachable externally" }
    },
    "required": ["targetPort", "sourcePort"]
  },
  "status_rules": []
}
```

| field                   | type     | meaning |
|-------------------------|----------|---------|
| `slug`                  | string   | unique; matched against `metadata.subType` |
| `name`                  | string   | shown in the UI |
| `description`           | string   | one line, shown under the picker and used as a default tagline |
| `target_kind`           | string   | `site`, `host`, or `service`. A resource whose `kind` differs is rejected. |
| `valid_parent_types`    | string[] | parent **kinds** this may be created under. Empty means anywhere. |
| `valid_parent_subtypes` | string[] | parent **subtypes**, narrower than the above. Empty means any. |
| `ssh_capable`           | boolean  | is this a machine you get a shell on, and therefore offerable as a jump target |
| `inherits_host_access`  | boolean  | is access decided by access to its host, rather than by groups of its own |
| `schema`                | object   | JSON Schema subset, below |
| `status_rules`          | array    | see [Status Rules](status-rules.html) |
| `icon`                  | string   | Font Awesome class, e.g. `fa-solid fa-server` |

### Capabilities

`ssh_capable` and `inherits_host_access` used to be hardcoded `Set`s in
`services/subtype_templates.js`. They are template fields now, which is what
makes a subtype an operator can add a *real* subtype rather than a label.

Two guard rails:

* **Out-of-band controllers can never be made shells.** `ilo`, `idrac`, `bmc`,
  `switch`, `ap`, `printer` and `camera` are refused ssh-capability regardless
  of what a template says. That an iLO is not a shell is a fact about the
  hardware, not a preference, and an accidental tick on that checkbox should
  not put a management controller in the jump-target list.
* **Failure is closed.** `templateFor()` is synchronous and on the access-
  projection request path, so templates are read into a cache at boot and after
  every write. If that cache has not loaded, or the database is unreachable,
  the old hardcoded tables answer — the conservative ones. A refresh that fails
  leaves the previous answers standing rather than emptying the cache.

## The schema

`schema` drives two things: the dynamic fields the resource modal renders in
Edit mode, and validation on `POST`/`PUT /api/directory-admin/resources`.

Supported `properties` entries:

| key           | effect on validation                | effect on the form           |
|---------------|-------------------------------------|------------------------------|
| `type: string`  | must be a string                  | text input                   |
| `type: number`  | must be a number                  | number input                 |
| `type: boolean` | must be a boolean                 | checkbox                     |
| `type: array`   | must be an array                  | comma-separated text input   |
| `enum: [...]`   | must be one of the listed values  | select                       |
| `description`   | —                                 | placeholder / checkbox label |

`required: ["a", "b"]` rejects a resource whose merged metadata leaves those
empty. Empty means `undefined`, `null` or `""`.

### Unknown fields

By default, metadata keys the schema does not declare are **allowed**. This is
deliberate. Discovery plugins write whatever the device actually reported —
`node` and `powerState` from Proxmox, `biosVersion` and `memoryGiB` from iLO,
`composeProject` from Docker — and a template that rejected everything it had
not declared would make every discovered resource impossible to save.

A template that genuinely owns its whole shape can opt in to strictness:

```json
"schema": { "properties": { "port": { "type": "number" } }, "additionalProperties": false }
```

Even then, keys the *platform* owns are always allowed, because they are not
the template's to declare: `subType`, `tags`, `environment`, `managed`,
`ignored`, `discovery_sources`, `sourceId`, `last_seen`, `hostId`, `status`,
`status_message`, `bubbled_environment`, `bubbled_tags`.

### Validation is on the merged result

A `PUT` may send only the fields a form changed. Validation runs against the
metadata that will actually be stored — existing metadata with the request
merged over it — not against the request body alone. A required field that is
already stored does not have to be re-sent.

## Hierarchy rules

Three fields together decide where a subtype may live:

```json
{ "slug": "linux",       "target_kind": "host",    "valid_parent_types": ["site", "host"] }
{ "slug": "theta-agent", "target_kind": "service", "valid_parent_types": ["host"] }
{ "slug": "proxmox-lxc", "target_kind": "host",    "valid_parent_types": ["host"],
  "valid_parent_subtypes": ["proxmox", "hypervisor", "server-proxmox"] }
```

`valid_parent_types` constrains the parent's **kind**. That is not enough on its
own for guests: a Proxmox LXC is a host under a host, so the kind check alone
would let you hang one off a laptop. `valid_parent_subtypes` is the narrower
constraint that stops it.

The resource modal only offers subtypes that are legal in the position the
resource is actually in, and re-filters when you change its kind or reparent it.
A resource already carrying a subtype that is not legal under its current parent
is flagged rather than silently reset — that usually means it was moved
somewhere its subtype does not belong.

## The shipped vocabulary

Seeded at boot, and never overwritten once present.

**Sites** — `suite`, `managed`, `wg-node`, `unmanaged`

**Hosts you log into** — `linux`, `windows`, `server`, `desktop`, `laptop`,
`proxmox` (the cluster, addressed by its API endpoint), `hypervisor` (one node
of it), `server-proxmox`, `server-hyperv`, `server-unraid`, and the guests
`lxc`, `vm`, `proxmox-lxc`, `proxmox-kvm`

**Hosts you do not** — `router`, `pfsense`, `switch`, `unifi_switch`, `ap`,
`unifi_ap`, `printer`, `camera`, `bmc`, `ilo`, `idrac`, `template`, `unknown`

**Services an agent reports** — `theta-agent`, `systemd`, `systemd-timer`,
`openrc`, `cron`, `windows-service`, `process`, `docker`, `podman`

**Services an operator models** — `port-forward`, `ssh`, `http`, `web`,
`wireguard`, `postgresql`, `redis`, `openbao_vault`, `k8s_deployment`,
`libvirt`, `kvm`, `zfs_pool`, `unifi`, `unknown-service`

`unknown` and `unknown-service` are what discovery uses when it genuinely cannot
tell. They are deliberately not ssh-capable: the `nmap` plugin used to emit no
subtype at all, and an empty subtype fell through to the ssh-capable default,
so every printer and camera a scan turned up was quietly offered as a jump
target.

## Defaults and replication

`SubtypeTemplate.seedDefaults()` runs at boot (`models/index.js`) and creates
any of the built-in slugs that are missing. It never overwrites one that
exists, so local edits survive restarts.

Across a multi-site cluster the **master is authoritative**, matched by slug:
a spoke's join adopts the master's templates, updating the slugs it already has
rather than skipping them. That is the point — every site seeds the same
defaults locally, so "only import what is missing" would mean the master's
customisations of `linux` or `proxmox` were exactly the ones that never
replicated.

## Editing

```
GET    /api/subtype-templates
GET    /api/subtype-templates/:slug
POST   /api/subtype-templates          { slug, name, target_kind, valid_parent_types, schema, status_rules, icon }
PUT    /api/subtype-templates/:id      any subset of the above
DELETE /api/subtype-templates/:id
```

Changing a template's `schema` does not rewrite existing resources. Fields that
are no longer declared stay in metadata and stop being rendered; a newly
`required` field is enforced the next time someone saves that resource.

## What renders on the form

The subtype's `schema.properties` become inputs in the resource modal, directly
under the subtype picker that selects the template.

A key the main form **already has an input for** is skipped
(`PLATFORM_METADATA_KEYS` in `views/directory.ejs`): `ip`, `address`, `port`,
`macAddress`, `os`, `vmid`, `environment`, `icon`, `tagline` and friends. A
template is free to declare them — `port` genuinely is part of what an `ssh`
service is, and it is what `View` mode reads to label the field — but rendering
a second control bound to the same metadata key gives two boxes for one value,
and whichever is written last silently wins. This is why the `web` subtype
shows no extra fields: both of its declared properties are platform keys.

The same rule is why `oauth` and `oidc-client` declare no schema at all.
Redirect URIs, scopes, allowed groups and token TTLs have a purpose-built panel
that also rotates the client secret, which a generic string input cannot do.

## OAuth clients are a subtype, not a kind

`kind: 'oauth'` no longer exists. An OAuth client is a **service** carrying
`metadata.subType: 'oauth'`, parented to the service it authenticates for — the
Proxy's client hangs off the Proxy.

A kind is a structural role in the graph, and an OAuth client is none of those
things structurally: it is one more thing a service exposes, alongside its HTTP
endpoint and its SSH port. As a kind it was an outlier that got no access groups,
had no subtype vocabulary at all, and needed a special-cased `relation: 'oauth'`
edge. As a subtype it inherits the whole model for free.

These subtypes set `inherits_host_access: true`, so they get no
`<slug>_access`/`_admin` pair of their own — an OAuth client's real
authorization is its own `allowed_groups`, checked at token issue, and a second
unrelated LDAP group pair per client would be sprawl with no decision behind it.
