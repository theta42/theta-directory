---
layout: default
title: Resource Facts
nav_order: 9
---

# Resource Facts

[← Back to Home](index.html)

More than one source can legitimately know something about the same
resource — Proxmox reports a guest's allocated memory, `theta-agent` reports
what's actually running inside it. Historically both wrote directly into the
same flat `resource.metadata`, last write wins: whichever source polled most
recently silently overwrote the other's value, with nothing kept to compare
against and no way to tell the two had ever disagreed.

This document covers the mechanism that replaced that: an additive,
per-source echo of every fact a discovery source or agent reports, and a
small canonical vocabulary so facts about the same concept — memory, disk,
cpu, network identity — can be found and compared regardless of which source
or which resource in the graph reported them.

Neither of these changes what `resource.metadata`'s flat fields mean or how
they're merged. Existing code that reads `resource.metadata.ram_total_gb`
sees exactly what it always saw. This is a parallel, additive layer a newer
UI consumes; it is not a replacement for the existing merge.

## The canonical vocabulary — a hard requirement

Every discovery plugin and driver that reports a numeric fact about a
resource **must** use these field names. This is the whole of the contract:
there is no separate mapping step, no per-subtype configuration. A field
under one of these names is automatically picked up; a field under any other
name is invisible to the facts layer, however useful it is for the plugin's
own subtype schema.

| Concept | Field name | Unit | Notes |
|---|---|---|---|
| CPU capacity | `cores` | count (integer) | |
| Memory capacity | `ram_total_gb` | **GiB**, not GB | See unit note below |
| Disk capacity | `disk_total_gb` | **GiB**, not GB | See unit note below |
| Network identity | `macAddress` | string (any format; normalized on read) | |
| Network identity | `ip` | string | |

Live, on-demand values (from a driver's `getMetrics()`, not persisted
discovery data) use their own existing field names —
`memoryUsedBytes`/`memoryTotalBytes`/`cpuUsagePct` (Proxmox),
`memory_bytes`/`cpu_usage_percent` (theta-agent per-service) — the facts
layer's normalizers (`public/js/resource_facts.js`) know how to read those
directly; nothing new to name there.

### The GiB-not-GB unit trap

`ram_total_gb` and `disk_total_gb` are computed by dividing bytes by
`1024³` (binary GiB), not `1000³` (decimal GB), despite the field name. This
was already true before this document existed — both the Proxmox plugin and
the agent's discovery path do it — and is called out explicitly here so it
never quietly becomes a real bug: anything that converts these fields to
bytes must multiply by `1024³`, and anything comparing them against a
byte-denominated live value (which is what the facts layer does) must use the
same conversion on both sides.

## How a fact survives: `facts_by_source`

`utils/fact_sources.js` exports one function:

```js
recordFactSources(mergedMeta, sourceName, fields)
```

Called from the two places that already merge incoming metadata
(`services/discovery_reconciler.js`, `utils/agent_manager.js`'s
`applyDiscoveryToDirectory`), right where each already builds the object it's
about to persist. The rule is blanket, not curated: every field the source is
about to write (except the bookkeeping keys `discovery_sources`/`last_seen`
itself) is echoed under
`resource.metadata.facts_by_source[sourceName]`, stamped with
`observed_at`. A curated list of "fields worth echoing" is one more thing to
remember to update as plugins gain fields — the kind of drift this whole
mechanism exists to stop reasoning about case by case — so there isn't one.

This is read-only from the facts layer's perspective. Nothing consumes
`facts_by_source` to decide what the flat merged value is; the existing
merge behavior in both files is completely unchanged. A resource created
before this shipped simply has no `facts_by_source` — the facts layer falls
back to reading its flat fields directly, tagged `source: 'unknown'`.

## Meshing a host with its children

`public/js/resource_facts.js` (dual CommonJS/browser module, unit-tested
under Jest, loaded via `<script src="/static/js/resource_facts.js">` in
`directory.ejs`) is where the vocabulary above gets used. Its job: given a
host resource and its children, gather every fact — static, from
`facts_by_source`, and live, from already-loaded driver/telemetry data — group
them by concept, and flag when two entries for the *same* concept, *same*
kind (static vs. live), *same* role (total vs. used vs. a plain percentage),
and *same* unit disagree by more than 10%. A live percentage is never
compared against a static byte total; they're answering different questions.

This is a pure, read-time transform. It makes no network calls beyond what
the page was already making for the resource open in front of you — a
child's live data is only included if it's already resident client-side
(agent-bound children, via the same telemetry the tree's status dots
already use). A child that would need its own on-demand `driver-metrics`
fetch (an `ssh`/`ilo`/Proxmox-guest child) is **not** fetched in v1; it's
named in a "N more children have their own live data" note instead. Pulling
those in too is a natural next step, deliberately not built yet.

`views/directory.ejs`'s `resourceFactsMeshHtml(resource, selfLive)` is the
thin rendering layer on top: one badge per contributing source, bordered when
its concept group disagrees, a hover tooltip showing how long ago that value
was observed. It also pulls a controllable child's own Start/Stop/Restart
buttons into the same card via the existing `serviceControlsHtml` — no
separate control-rendering path for meshed children.

## What's still out of scope

- Live facts from a child that needs its own fetch (see above).
- Reconciling `hostTelemetryHtml`/`proxmoxGuestStatusHtml`/`serviceStatusHtml`'s
  own summary numbers with the meshed card below them — both are shown today,
  which can look like double-counting on a host with few children. Rewriting
  those three existing renderers to stop duplicating is real surgery on
  complex code, not part of this pass.
- A resolution policy beyond "flag disagreement and show both." Nothing here
  picks a winner; that's deliberate — see the framing at the top of this
  document.
