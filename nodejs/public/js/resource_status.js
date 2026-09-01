'use strict';

// Shared resource-status helpers for the Directory page. Dual-exported: a
// plain CommonJS module in Jest (`require('../public/js/resource_status')`)
// and `window.ResourceStatus` in the browser via a plain <script src> tag --
// same file, no build step, so the pure logic below is actually unit
// testable, which nothing client-side in directory.ejs was before.
//
// Consolidates three previously-independent copies of the same health-bucket
// counting logic (viewPaneHtml, childrenRollupHtml, and the site branch of
// loadResourceStatus in directory.ejs) and the badge/state-text contradiction
// bug: `svc.active !== false` treated a service with no telemetry at all
// (`svc.active === undefined`) as confirmed "Active", while a sibling
// expression in the same function treated the same undefined value as
// "inactive" -- rendering a green Active badge next to a State: inactive row
// for the identical service, live, on the Theta Agent's own Status card.

(function (root) {
  // Canonical single-resource health bucket. Falls back to a powerState
  // inference when neither `status` nor `bubbled_status` has been computed
  // yet -- metadata.status is written asynchronously by the scheduler tick
  // (docs/status-rules.md), so a resource can be legitimately unevaluated for
  // a while after discovery, and a known powerState is strictly more
  // informative than "unknown" during that gap.
  function bucketResourceStatus(resource) {
    const md = (resource && resource.metadata) || {};
    const status = md.status || md.bubbled_status ||
      (md.powerState === 'running' ? 'ok' : (md.powerState === 'stopped' ? 'warning' : 'unknown'));
    if (status === 'ok') return 'ok';
    if (status === 'warning') return 'warning';
    if (status === 'critical' || status === 'error') return 'critical';
    return 'unknown';
  }

  function bucketResourceStatuses(resources) {
    const counts = { ok: 0, warning: 0, critical: 0, unknown: 0 };
    for (const r of resources || []) counts[bucketResourceStatus(r)]++;
    return counts;
  }

  // A service's active/inactive/unknown state, from whatever a driver
  // reported as `svc.active`. Undefined (no telemetry at all) is 'unknown',
  // not 'active' -- the fix for the badge/state contradiction above.
  function serviceActiveState(svc) {
    if (!svc) return 'unknown';
    if (svc.active === true) return 'active';
    if (svc.active === false) return 'inactive';
    return 'unknown';
  }

  // The allEdges.filter(...).map(...).filter(Boolean) idiom, copy-pasted
  // across directory.ejs.
  function childrenOf(resourceId, edges, resourcesById) {
    return (edges || [])
      .filter((e) => e.parentId === resourceId)
      .map((e) => resourcesById[e.childId])
      .filter(Boolean);
  }

  const ResourceStatus = {
    bucketResourceStatus,
    bucketResourceStatuses,
    serviceActiveState,
    childrenOf
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ResourceStatus;
  } else {
    root.ResourceStatus = ResourceStatus;
  }
})(typeof window !== 'undefined' ? window : this);
