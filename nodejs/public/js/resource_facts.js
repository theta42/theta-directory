'use strict';

// Meshes a host's own facts with its children's facts into one normalized,
// conflict-flagged structure -- purely a read-time transform over data
// already resident client-side (persisted metadata + already-loaded agent
// telemetry). It never writes anything back; nothing here changes what
// discovery_reconciler.js/agent_manager.js persist. See docs/resource-facts.md
// for the canonical vocabulary this is built around, which is a hard
// requirement for any plugin/driver that wants its numbers to show up here.
//
// Dual-exported the same way as resource_status.js: plain CommonJS in Jest,
// `window.ResourceFacts` in the browser.
//
// v1 vocabulary is deliberately small -- four concepts, only what's needed to
// answer "does it agree": cpu, memory, disk (each as a live and/or static
// FactValue) and network (identity only -- MAC/IP agreement -- no live
// throughput, since that only ever exists on one side today and has nothing
// to disagree with).

(function (root) {
  const FACT_CONCEPTS = ['cpu', 'memory', 'disk', 'network'];
  const CONCEPT_LABELS = { cpu: 'CPU', memory: 'Memory', disk: 'Disk', network: 'Network' };

  // ram_total_gb/disk_total_gb are actually GiB (division by 1024^3 at the
  // source) despite the "gb" name -- see docs/resource-facts.md. Converting
  // to bytes here so every memory/disk FactValue is comparable regardless of
  // whether it came from a static discovery field or a live byte counter.
  const BYTES_PER_GB = 1024 * 1024 * 1024;

  function pushFact(bucket, concept, entry) {
    bucket[concept] = bucket[concept] || [];
    bucket[concept].push(entry);
  }

  // Static per-source facts: reads metadata.facts_by_source (see
  // utils/fact_sources.js) generically -- source-name-agnostic, so a new
  // discovery source needs no code change here to show up. Falls back to the
  // flat fields tagged source:'unknown' for a resource that predates
  // facts_by_source.
  function factsFromMetadata(metadata, resourceId, resourceName) {
    const out = { cpu: [], memory: [], disk: [], network: [] };
    const md = metadata || {};
    const bySource = (md.facts_by_source && Object.keys(md.facts_by_source).length)
      ? md.facts_by_source
      : { unknown: md };

    Object.keys(bySource).forEach((source) => {
      const fields = bySource[source] || {};
      const at = fields.observed_at || md.last_seen || null;

      if (fields.cores != null) {
        pushFact(out, 'cpu', { source, kind: 'static', role: 'total', unit: 'count', value: fields.cores, observedAt: at, resourceId, resourceName });
      }
      if (fields.ram_total_gb != null) {
        pushFact(out, 'memory', { source, kind: 'static', role: 'total', unit: 'bytes', value: fields.ram_total_gb * BYTES_PER_GB, observedAt: at, resourceId, resourceName });
      }
      if (fields.disk_total_gb != null) {
        pushFact(out, 'disk', { source, kind: 'static', role: 'total', unit: 'bytes', value: fields.disk_total_gb * BYTES_PER_GB, observedAt: at, resourceId, resourceName });
      }
      if (fields.macAddress) {
        pushFact(out, 'network', { source, kind: 'static', role: 'identity', unit: 'string', value: String(fields.macAddress).toLowerCase(), observedAt: at, resourceId, resourceName });
      }
      if (fields.ip) {
        pushFact(out, 'network', { source, kind: 'static', role: 'identity', unit: 'string', value: fields.ip, observedAt: at, resourceId, resourceName });
      }
    });

    return out;
  }

  // Live self facts for a Proxmox guest host, from the driver-metrics
  // response's m.guestStats (proxmox_driver.js). Always "now" -- it's a live,
  // on-demand read, not a stored value.
  function factsFromProxmoxGuestSnapshot(driverMetrics, resourceId, resourceName) {
    const out = { cpu: [], memory: [], disk: [] };
    const gs = driverMetrics && driverMetrics.guestStats;
    if (!gs) return out;
    const source = 'proxmox';
    const at = Date.now();
    if (gs.cpuUsagePct != null) pushFact(out, 'cpu', { source, kind: 'live', role: 'pct', unit: 'percent', value: gs.cpuUsagePct, observedAt: at, resourceId, resourceName });
    if (gs.memoryUsedBytes != null) pushFact(out, 'memory', { source, kind: 'live', role: 'used', unit: 'bytes', value: gs.memoryUsedBytes, observedAt: at, resourceId, resourceName });
    if (gs.diskUsedBytes != null) pushFact(out, 'disk', { source, kind: 'live', role: 'used', unit: 'bytes', value: gs.diskUsedBytes, observedAt: at, resourceId, resourceName });
    return out;
  }

  // Live self facts for a plain host with a directly-bound agent. Mirrors
  // (does not refactor) the same total/used byte fallback chain
  // hostTelemetryHtml already uses, so this reads the same numbers that
  // dashboard shows.
  function factsFromAgentHostSnapshot(agent, resourceId, resourceName) {
    const out = { cpu: [], memory: [], disk: [] };
    if (!agent) return out;
    const source = 'theta-agent';
    const t = agent.lastTelemetry || {};
    const d = agent.lastDiscovery || {};
    const at = agent.lastSeen ? Date.parse(agent.lastSeen) : (agent.last_seen ? agent.last_seen * 1000 : Date.now());

    if (t.cpu_usage_percent != null) {
      pushFact(out, 'cpu', { source, kind: 'live', role: 'pct', unit: 'percent', value: t.cpu_usage_percent, observedAt: at, resourceId, resourceName });
    }

    const ram = t.ram_details || d.ram_details || {};
    const totalRamBytes = ram.total_bytes || (d.ram_total_gb ? d.ram_total_gb * BYTES_PER_GB : null);
    const usedRamBytes = ram.used_bytes != null
      ? ram.used_bytes
      : (totalRamBytes != null && t.ram_usage_percent != null ? totalRamBytes * t.ram_usage_percent / 100 : null);
    if (usedRamBytes != null) {
      pushFact(out, 'memory', { source, kind: 'live', role: 'used', unit: 'bytes', value: usedRamBytes, observedAt: at, resourceId, resourceName });
    }

    if (t.disk_usage_percent != null) {
      pushFact(out, 'disk', { source, kind: 'live', role: 'pct', unit: 'percent', value: t.disk_usage_percent, observedAt: at, resourceId, resourceName });
    }
    return out;
  }

  // Live facts for a child service backed by an agent -- same ServiceMetric
  // shape liveServiceMetric(r) already returns (it reads the same
  // agent.lastTelemetry.services entry theta_agent_driver.js's own
  // getMetrics() builds `service` from), so this needs no new fetch.
  function factsFromAgentServiceSnapshot(svc, resourceId, resourceName, observedAt) {
    const out = { cpu: [], memory: [] };
    if (!svc) return out;
    const source = 'theta-agent';
    if (typeof svc.cpu_usage_percent === 'number') {
      pushFact(out, 'cpu', { source, kind: 'live', role: 'pct', unit: 'percent', value: svc.cpu_usage_percent, observedAt, resourceId, resourceName });
    }
    if (typeof svc.memory_bytes === 'number') {
      pushFact(out, 'memory', { source, kind: 'live', role: 'used', unit: 'bytes', value: svc.memory_bytes, observedAt, resourceId, resourceName });
    }
    return out;
  }

  function relativeDelta(a, b) {
    const max = Math.max(Math.abs(a), Math.abs(b));
    if (max === 0) return 0;
    return Math.abs(a - b) / max;
  }

  // Same-kind, same-role, same-unit entries are compared pairwise -- a live
  // percent and a static byte-total are answering different questions, not
  // disagreeing, so they're never compared against each other.
  const CONFLICT_TOLERANCE = 0.10;

  function detectConflict(entries) {
    const groups = new Map();
    (entries || []).forEach((e) => {
      const key = e.kind + '|' + e.role + '|' + e.unit;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    });
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      if (group[0].unit === 'string') {
        const values = new Set(group.map((g) => String(g.value).toLowerCase()));
        if (values.size > 1) return true;
      } else {
        const values = group.map((g) => Number(g.value));
        if (relativeDelta(Math.max(...values), Math.min(...values)) > CONFLICT_TOLERANCE) return true;
      }
    }
    return false;
  }

  // Gathers facts from a host and its children into one grouped, conflict-
  // flagged structure.
  //
  // children: [{ resource, live, needsOwnFetch }] -- `live` is a
  // factsFromAgentServiceSnapshot()-shaped bucket or null; `needsOwnFetch` is
  // true for a non-agent-bound child (ssh/ilo/proxmox-guest) that would need
  // its own on-demand driver-metrics fetch to contribute live facts here.
  // Those are counted, not fetched -- zero new network calls in v1, a
  // deliberate scope boundary (see docs/resource-facts.md).
  function buildResourceFactsMesh({ resource, selfLive, children }) {
    const buckets = { cpu: [], memory: [], disk: [], network: [] };
    const selfName = resource ? (resource.name || resource.slug) : 'this resource';
    const selfStatic = factsFromMetadata(resource && resource.metadata, resource && resource.id, selfName);
    FACT_CONCEPTS.forEach((c) => buckets[c].push(...(selfStatic[c] || [])));
    if (selfLive) FACT_CONCEPTS.forEach((c) => { if (selfLive[c]) buckets[c].push(...selfLive[c]); });

    let skippedChildrenCount = 0;
    (children || []).forEach((child) => {
      const cr = child.resource;
      const childName = cr ? (cr.name || cr.slug) : 'child';
      const childStatic = factsFromMetadata(cr && cr.metadata, cr && cr.id, childName);
      FACT_CONCEPTS.forEach((c) => buckets[c].push(...(childStatic[c] || [])));
      if (child.live) FACT_CONCEPTS.forEach((c) => { if (child.live[c]) buckets[c].push(...child.live[c]); });
      if (child.needsOwnFetch) skippedChildrenCount++;
    });

    const groups = FACT_CONCEPTS
      .map((concept) => ({
        concept,
        label: CONCEPT_LABELS[concept],
        entries: buckets[concept],
        conflict: detectConflict(buckets[concept])
      }))
      .filter((g) => g.entries.length > 0);

    return { groups, skippedChildrenCount };
  }

  const ResourceFacts = {
    FACT_CONCEPTS,
    factsFromMetadata,
    factsFromProxmoxGuestSnapshot,
    factsFromAgentHostSnapshot,
    factsFromAgentServiceSnapshot,
    buildResourceFactsMesh
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ResourceFacts;
  } else {
    root.ResourceFacts = ResourceFacts;
  }
})(typeof window !== 'undefined' ? window : this);
