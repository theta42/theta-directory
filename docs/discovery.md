---
layout: default
title: Discovery & Inventory
nav_order: 6
---

# Discovery & Inventory

[← Back to Home](index.html)

The Directory holds two different kinds of thing, and the distinction matters
for every consumer of the directory:

- **Catalog resources** — what you have declared. Created by hand, seeded by
  `setup.sh`, or *promoted* from a discovery result. These get LDAP access
  groups, appear in the Catalog, and are the only hosts the
  [jump host](https://github.com/theta42/jump-host) will connect you to.
- **Discovered resources** — what the network reports. Produced by
  [discovery plugins](plugins.html) and shown on the **Discovered Inventory**
  tab. They are a queue of "this exists, do you want to manage it?", not
  infrastructure you have committed to.

A resource is discovery-only when its `metadata.discovery_sources` is non-empty
and it has never been promoted. Promoting sets `metadata.managed = true`, at
which point it becomes catalog content like any other resource.

> Nothing grants access to a discovered resource. It carries no groups until it
> is promoted, and the jump host applies the same rule — an unpromoted Proxmox
> guest is not a jump target.

---

## Where discovered data comes from

| Source | What it reports |
| :--- | :--- |
| [Proxmox](plugins.html) | The cluster endpoint, its nodes, and every VM/LXC with NICs, `vmid` and node |
| [UniFi](plugins.html) | Network devices and connected clients, by MAC |
| [nmap](plugins.html) | Hosts and open ports on a target range |
| [Docker](plugins.html) | Containers on a local or remote daemon |
| [theta-agent](agents.html) | The host it runs on — OS, kernel, CPU, RAM, disk, addresses |
| [ldap-client](directory.html) | A Linux host registering itself when it joins |

An agent is the most authoritative of these: it runs *on* the machine it
describes. A network scan is the least — it only knows what answered.

---

## How results are matched to existing resources

Every source runs through one reconciler, so two sources seeing the same
machine converge on one resource instead of creating duplicates. Matching is
tried in order of precision:

1. **MAC address** — the strongest signal, compared across every interface.
2. **IP address** — any address on any interface, plus `metadata.address`.
3. **Slug, name, or base hostname** — last resort.

A candidate must also be **the same kind**. Without that guard a discovered VM
named `gitea-runner` would match a hand-created *service* of the same name on
rule 3 and overwrite it. (`template` counts as `host`: converting a VM to a
template is the same machine.)

When a match is found the metadata is merged, interfaces are unioned by MAC, and
the source is added to `discovery_sources` — so a resource can legitimately read
`["unifi", "proxmox"]`, meaning two independent sources agree it exists.

### Naming

Sources disagree about names, so the most human one wins: a **hostname** beats
an **IP-shaped** name, which beats a **MAC-shaped** name; length is only a
tie-break within a rank. This is why a device UniFi knows only as
`ac:16:2d:b3:da:80` is renamed `dl380-0` once Proxmox reports it.

### Relationships

Plugins emit edges as well as resources (a Proxmox node under its cluster
endpoint, a guest under its node). The reconciler refuses any edge that would
make a resource its own parent, or that would close a loop — a cycle renders as
an infinitely nested tree and breaks every ancestor walk in the app.

---

## Promoting a discovered resource

On the **Discovered Inventory** tab, press **Promote**. The resource form opens
pre-filled with what was discovered — name, kind, address, subtype — so you can
correct it before committing. Saving marks it managed and provisions its
[LDAP groups](groups.html).

Each row shows what the directory knows about the device: its source(s), its
`vmid` where applicable, the identifier it has at that source (`sourceId`, e.g.
`dl380-0/qemu/234`), and every interface with its MAC and address. If a row
looks wrong, that detail is where to start.

---

## Stale results

Resources that are *only* auto-discovered are garbage-collected: if a source
stops reporting one for long enough it is marked
`lifecycle_state: "archived"` rather than deleted. Anything you created or
promoted is never touched — `manual` in `discovery_sources` exempts it.

A Proxmox node that is powered off is still reported (with its `status`), so
downtime does not look like decommissioning.

---

## What the stack discovers about itself

`setup.sh` seeds its own components as catalog resources — the site, the stack
host, `theta-proxy` and `theta-jump`, and the services under them. The Docker
discovery plugin then finds the containers backing them. Containers belonging to
the theta-suite compose project are recognised and attached to the service they
implement rather than appearing as unmanaged strangers, so a fresh install has an
empty Discovered Inventory rather than five things demanding attention.
