---
layout: default
title: Writing Discovery Plugins
nav_order: 10
---

# Writing Discovery Plugins

[← Back to Home](index.html)

A discovery plugin finds things on a network and hands them to the directory.
This page is the contract: what a plugin must emit, what the platform guarantees
in return, and the rules that exist because breaking them is silent.

## Shape

A plugin is one file at `nodejs/plugins/discovery/<type>.js` exporting a
manifest:

```js
module.exports = {
  type: 'proxmox',
  category: 'discovery',
  name: 'Proxmox VE',
  description: 'Discover nodes, VMs and containers from a Proxmox cluster.',
  configSchema: [
    { key: 'url',      label: 'API URL',  type: 'url',      required: true },
    { key: 'password', label: 'Password', type: 'password', required: true, secret: true },
    { key: 'location', label: 'Location / Site', type: 'site_select' }
  ],
  validate: async (config) => ({ ok: true }),      // the "Test" button
  discover: async (config) => ({ resources, edges }),
  run: async (config) => module.exports.discover(config)
};
```

`configSchema` drives both the admin form and API validation. Fields marked
`secret: true` are stored in OpenBao, never in the database, and merged back in
at run time. Everything else lives on the instance row.

A **type** is the file. An **instance** is a configured copy of it — you can
have several Proxmox clusters. The instance's `slug` is the discovery source
name, and it is what edge provenance and pruning key on.

## The payload

```js
{
  resources: [{ kind, name, slug, metadata }],
  edges:     [{ parentSlug, childSlug, relation }]
}
```

It is validated before it reaches the reconciler. A payload that is not an
object, or whose `resources`/`edges` are not arrays, fails the run. Individually
malformed rows are dropped and logged rather than failing the whole run — one
bad guest out of fifty should not discard the other forty-nine.

### `kind` is closed and structural

`site`, `host`, `service`, `oauth`. Nothing else. A row with any other kind is
dropped by the validator.

This is enforced because it was not. Plugins invented `bmc`, `network_device`,
`container` and `template`, none of which the system understood, and the
consequence was invisible: `groupKind()` returned null for all of them, so those
resources **never got access groups** and quietly fell back to a second,
incompatible naming scheme in the promote path.

`kind` says where a thing sits in the graph. *What it is* goes in
`metadata.subType`.

### `metadata.subType` is not optional

Every resource should carry one, from the vocabulary in
[subtype templates](subtype-templates.html).

Omitting it is not neutral. An empty subType falls into the ssh-capable
bucket, so a plugin that emitted no subtype turned every printer, camera,
switch and phone it found into a candidate SSH jump target. Both `nmap` and
`unifi` did exactly this.

If you cannot tell what something is, emit `unknown` (hosts) or
`unknown-service` (services). Those are real templates, and they are
deliberately **not** ssh-capable — classification failure fails closed.

Mark inferred classifications with `subTypeSource` (`'nmap-inference'`,
`'unifi-inference'`) so a guess and an operator's decision do not look alike.

### `metadata.sourceId` is your stable key

The reconciler matches on UUID, then verified MAC, then — only within the same
site — IP and name. `sourceId` is how you say "this is the same thing I reported
last time" without relying on weak matching. Use whatever the upstream system
considers stable: a serial number, a MAC, `node/lxc/vmid`.

### What you must not write

`metadata.environment` is **operator-owned**. It is prod/testing/dev, it bubbles
up the tree, and no plugin sets it. Report `powerState` instead — a powered-off
production database is still production, and deriving environment from run state
re-labelled an entire site every time a VM stopped.

## Guarantees the platform gives you

**A timeout.** Every run is bounded (`PluginInstance.timeoutMs`, default 5
minutes, max 1 hour). A plugin that hangs is abandoned and the instance is
marked failed.

**Isolation from maintenance.** Plugin runs have their own queue. Garbage
collection and status evaluation run on a separate one, so a hung plugin cannot
freeze the status of every resource in the directory — which it used to.

**Cleanup on removal.** Deleting an instance removes the resources and edges
that source created. A resource another source also reported survives and just
loses the attribution; one an operator promoted is kept by default
(`?keepPromoted=false` to override).

**Edge provenance.** Edges you emit are stamped with your instance slug, which
is what lets a later run reparent a guest that moved and prune only the edges
you own. Edges made by hand carry no source and are never pruned by a plugin.

**Per-source fact provenance.** Every field you report is automatically
echoed under `metadata.facts_by_source[yourSourceName]` alongside the
existing flat merge — you don't need to do anything for this. It's what lets
a later UI show your value next to another source's for the same resource
instead of one silently overwriting the other. See
[Resource Facts](resource-facts.html).

## Rules of thumb

**Fail partially, not totally.** Wrap per-item work so one bad node does not
discard the payload. But if *everything* failed, throw — an empty successful run
looks like "the cluster is gone" and prunes edges accordingly.

**Never guess across a boundary.** Do not merge by IP or hostname yourself; hand
the reconciler your facts and let its rules apply. Cross-site matching is how
one rack's telemetry ended up on another rack's resource.

**Make policy configurable.** The Docker plugin's ignore list was a hardcoded
`/openbao|bao-renewer/` regex — right for this stack, useless to anyone else,
and unchangeable without editing the file. It is a config field now.

**Volume is a decision.** UniFi imports every DHCP client on the LAN if asked.
That is off by default: a directory of managed infrastructure and a DHCP lease
table are different products.

**Name numeric facts from the canonical vocabulary.** `cores`, `ram_total_gb`,
`disk_total_gb`, `macAddress`, `ip` — see
[Resource Facts](resource-facts.html) for the full list and the GiB-not-GB
unit trap. A field under any other name still works for your subtype's own
schema; it just won't be findable by another source reporting the same
concept under a different name.

## Testing

`tests/plugin_contract.test.js` asserts the invariants above across every
installed plugin — canonical kinds, classifiers returning real subtypes, nothing
unclassifiable becoming ssh-capable. A new plugin is covered by it automatically;
if it fails, the plugin is wrong.
