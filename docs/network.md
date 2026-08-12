---
layout: default
title: The Site Network
---

# The Site Network

The directory is where the WireGuard cluster is configured. Each site's gateway
reads what is here and configures itself — there is no separate mesh to set up
and no second place to keep in sync.

**Joining the directory is joining the network.** A site that completes
[multi-site join](site-join.html) is allocated a site id, and every address it
uses follows from that number.

## Who owns what

| | Owns | Never touches |
|---|---|---|
| **The directory** | The site id (the one cluster-unique value), the roster, device records, exit permissions | Any gateway's WireGuard config |
| **A gateway** | Its own site's network: keys, interfaces, routes, NAT | Any other site's row |

A gateway publishes the two facts only it knows — its public key and its
dialable endpoint — and reads everything else. The publish endpoint takes no
site parameter: which row a gateway writes is decided by which node it is
talking to. So one site cannot rewrite another's network config, and a
partition cannot corrupt anyone.

## Site ids

A site id is the site's **LDAP ServerID**, allocated by the master when the site
joins and stable for the life of the site. One number drives LDAP replication,
the gateway's mesh address, and the site's whole private range.

This caps a cluster at **254 sites**. LDAP itself allows 4094 server IDs, but
the addressing gives each site one octet, so the addressing is the limit.

## The Network page

### Sites

Every site in the cluster, its addresses, and whether its gateway has actually
published a key. A site that has joined but whose gateway has never started
shows as **not started** — it is in the roster and not yet on the wire, which
is a real state worth distinguishing from a broken tunnel.

Admins set per site:

- **LAN ranges.** Each site's physical LAN is mapped 1:1 into a slot of its own
  range, because nearly every LAN is `192.168.1.0/24` and three of them would
  otherwise be indistinguishable. With site 2's LAN set to `192.168.1.0/24`,
  the machine at `192.168.1.53` is `10.2.168.53` from anywhere in the cluster.
- **DNS server.** An address on one of those LANs. Devices are handed the
  *mapped* address, not the one you type — `192.168.1.1` at site 2 becomes
  `10.2.168.1`, which resolves from anywhere. The form shows the translation as
  you type and warns when an address is not inside either mapped LAN, in which
  case it cannot be mapped and devices would get no resolver at all.
- **Offers an exit**, plus country and city for the picker.
- **Hub.** Exactly one site carries `10.0.0.0/8` as a catch-all so sites that
  are not directly peered still reach each other. Pick something always-up and
  publicly reachable — usually a cheap VPS, not necessarily wherever the master
  directory happens to live.

### My Devices

Any signed-in user enrols their own devices; this is not an admin task.

**Keys are the user's choice.** Paste a public key generated on the device and
the private half never reaches the server. Leave it blank and one is generated,
rendered into a config once, and forgotten — not stored, not recoverable, not
logged. Lose it and you delete the device and enrol again.

Devices running [theta-agent](agents.html) are pushed their configuration over
the agent's existing connection. Everything else gets a config to copy.

Each device gets an address from its site's pool (`10.<siteId>.128.0/17`, 32512
per site) and can reach every site in the cluster.

### Exit Access

Which users may route their internet traffic out of which site. Two independent
things:

- A site marked **offers an exit** is saying it is *willing* to carry traffic.
- A **grant** says a particular user may use it.

Willingness is not permission — an admin grants explicitly. Revoking a grant
immediately drops any device using that exit back to local breakout, rather
than leaving it routed somewhere its owner may no longer go.

Users then pick per device. **Changing an exit never reconfigures the device** —
the gateway rewrites one routing rule, so there is no reconnect and no reissued
config.

## API

| Endpoint | Who | What |
|---|---|---|
| `GET /api/mesh/roster` | any signed-in | Every site: addresses, keys, exits, LAN mapping |
| `GET /api/mesh/peers` | gateways | Peers to build, AllowedIPs already resolved |
| `GET /api/mesh/site-clients` | gateways | Devices at this site and each one's exit |
| `PUT /api/mesh/self` | gateways | Publish this gateway's key and endpoint |
| `PUT /api/mesh/sites/:siteId` | admin | LAN, DNS, exit settings |
| `PUT /api/mesh/hub/:siteId` | admin | Designate the hub |
| `GET/POST/DELETE /api/mesh/exit-grants` | admin | Who may use which exit |
| `GET/POST/DELETE /api/mesh/clients` | user | Own devices |
| `PUT /api/mesh/clients/:id/exit` | user | Pick an exit |
| `POST /api/mesh/clients/:id/push` | user | Send config to the device's agent |

Peer AllowedIPs are resolved here rather than on each gateway, so the addressing
rules live in one place.

## How the roster reaches every site

Written at each site, distributed by the master:

- A gateway publishes its keys and endpoint to **its own** directory.
- A spoke's directory forwards that to the master over the channel it already
  has (`POST /api/site/spokes`, with the join key it already holds) — without
  this upward path a spoke's public key never leaves the spoke and no other
  site could build a peer for it.
- The master carries the whole roster in its export, so joining and every
  resync bring it down to every spoke. Roster edits push a resync immediately
  rather than waiting for an unrelated catalog change.

A site's own row is never overwritten by an incoming export: its gateway
publishes locally first and pushes up second, so the local copy is always at
least as fresh.

## Reaching another site's directory

A peer site's directory is `10.<siteId>.0.2:3001`. Replication prefers that
path and falls back to the site's public endpoint if it fails, so a deployment
whose containers have no route into the mesh still replicates — just over the
internet rather than the tunnel.

For the mesh path to work, this container needs a route for `10.0.0.0/8` via
the local gateway. See [the gateway's network
docs](https://theta42.github.io/theta-suite/jump-host/mesh.html).

## What is not implemented

- **Key rotation.** A gateway's keypair is generated once and kept. Every peer
  holds the public half, so rotating one is a cluster-wide event.
- **Reaching a roaming device that failed over to another site.** A device
  attached to a backup gateway can reach out, but nothing can reach *it* until
  it is home again.
