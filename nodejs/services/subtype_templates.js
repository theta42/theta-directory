'use strict';

// What a resource of a given kind/subType gets, automatically.
//
// THE PROBLEM THIS SOLVES
//
// Two rules about resources were spread across the codebase as ad-hoc checks,
// and both were wrong in the same direction -- they required a human to do
// something before the obvious thing happened:
//
//   1. A Linux host running theta-agent was not a jump target. jump-host asks
//      the Directory which resources a user may reach (GET
//      /api/discovery/access/:uid) and offers the hosts among them. Nothing
//      ever gave an agent-enrolled host the groups that projection keys on, so
//      an operator who had installed the agent -- proving they administer the
//      machine -- still saw a single jump target: the stack host the installer
//      creates by hand. Every other agent host had to be granted access one
//      LDAP group at a time.
//
//   2. Every registered service got its own pair of LDAP groups. A systemd
//      unit is not an access boundary; whoever administers the host
//      administers its units. One `svc-<host>-systemd-<unit>_access` group per
//      unit per host is group sprawl with no decision behind it, and it left
//      the service invisible to the very people who could already log into the
//      machine and type `systemctl`.
//
// Both are properties of what the resource IS, so they belong in one table
// keyed on that, rather than in whichever call site noticed the need first.

// BOOTSTRAP TABLES. The authoritative answers now live on the SubtypeTemplate
// rows (`ssh_capable`, `inherits_host_access`), read through the cache below.
// These are what answer before that cache has loaded and if the database is
// unreachable, and they are kept in step with the seeded defaults.
//
// Host subtypes that are a machine you log into. `proxmox` and `hypervisor`
// are deliberately included -- they are Linux hosts with a shell -- while a
// `bmc`/`ilo` out-of-band controller is not, and neither is a `site`.
const SSH_CAPABLE_HOST_SUBTYPES = new Set([
  'linux', 'lxc', 'vm', 'proxmox', 'hypervisor', 'debian', 'ubuntu', 'server', ''
]);

// Subtypes that are explicitly NOT a shell, whatever else is true of them.
const NEVER_SSH_SUBTYPES = new Set(['ilo', 'bmc', 'idrac', 'switch', 'ap', 'printer', 'camera']);

// A service resource whose lifecycle an agent reports. These inherit access
// from the host that runs them and have no groups of their own.
//
// `theta-agent` belongs here for the same reason the rest do, and the reason
// is worth stating: since the agent binds to a `theta-agent` service child
// rather than to the host itself, every single enrolment mints one of these
// rows. Left out of this set it would get its own <slug>_access/<slug>_admin
// pair, so a fleet of N machines would produce 2N LDAP groups nobody ever
// grants -- exactly the sprawl this table was written to stop.
const AGENT_SERVICE_SUBTYPES = new Set([
  'theta-agent', 'port-forward',
  'systemd', 'docker', 'podman', 'process', 'openrc', 'systemd-timer', 'cron'
]);

// ── The template cache ──────────────────────────────────────────────────────
//
// templateFor() is called inside access projection, once per resource, on the
// request path -- so it has to be synchronous, while the templates themselves
// live in the database. This cache is the bridge: refreshed at boot and after
// every write to a template, read synchronously from then on.
//
// The Sets above are the BOOTSTRAP, not dead code. They are what answers before
// the first refresh completes and if the database is unreachable, and they are
// deliberately the same answers the seeded defaults give. A security predicate
// that became permissive -- or that started handing out groups it should not --
// because a cache had not loaded yet is precisely the failure this must not
// have, so the fallback is the conservative hardcoded table rather than "no
// template, allow everything".
let templateCache = null;

async function refreshTemplateCache() {
  try {
    const { SubtypeTemplate } = require('../models/subtype_template');
    const rows = await SubtypeTemplate.list();
    const next = new Map();
    for (const t of rows) {
      next.set(String(t.slug).toLowerCase(), {
        targetKind: t.target_kind,
        identityClass: t.identity_class || t.target_kind,
        sshCapable: Boolean(t.ssh_capable),
        inheritsHost: Boolean(t.inherits_host_access),
        validParentTypes: t.valid_parent_types || [],
        validParentSubtypes: t.valid_parent_subtypes || [],
        icon: t.icon || null
      });
    }
    templateCache = next;
    return next.size;
  } catch (err) {
    console.warn('[subtype_templates] could not refresh the template cache:', err.message);
    return 0;
  }
}

function cachedTemplate(subType) {
  if (!templateCache) return null;
  return templateCache.get(subType) || null;
}

// Test seam: set the cache directly without a database.
function _setTemplateCache(entries) {
  templateCache = entries ? new Map(Object.entries(entries)) : null;
}

// templateFor answers, for one resource, the questions the rest of the system
// used to guess at.
//
//   sshCapable    -- may this be offered as a jump target at all
//   ownGroups     -- does it get its own <slug>_access/<slug>_admin pair
//   inheritsHost  -- is access to it decided by access to its host
function templateFor(resource) {
  const meta = (resource && resource.metadata) || {};
  const kind = (resource && resource.kind) || '';
  const subType = String(meta.subType || '').toLowerCase();
  const tpl = cachedTemplate(subType);

  if (kind === 'host') {
    // NEVER_SSH_SUBTYPES still wins outright. A template is operator-editable,
    // and "an iLO is not a shell" is a fact about the hardware, not a
    // preference -- an accidental tick of `ssh_capable` on a BMC should not
    // put an out-of-band controller in the jump-target list.
    if (NEVER_SSH_SUBTYPES.has(subType)) {
      return { kind, subType, sshCapable: false, ownGroups: true, inheritsHost: false };
    }
    const sshCapable = tpl ? tpl.sshCapable : SSH_CAPABLE_HOST_SUBTYPES.has(subType);
    return { kind, subType, sshCapable, ownGroups: true, inheritsHost: false };
  }

  if (kind === 'service' || kind === 'container') {
    // The SUBTYPE decides this, and nothing else. It used to also require a
    // `metadata.agentId` on the row, which is gone -- agent binding is an edge
    // in the graph now, and templateFor answers from the row alone.
    //
    // Losing that second condition costs nothing, because it was never what
    // protected the case the old comment worried about: a hand-created catalog
    // entry like the stack's own `sso-manager-<site>` is subType `web`, which
    // is not an inheriting subtype and so still keeps its own groups. What IS
    // -- a systemd unit, a container, a port forward -- is not an access
    // boundary whoever created the row: if you administer the host you can
    // already type `systemctl`.
    const agentManaged = tpl ? tpl.inheritsHost : AGENT_SERVICE_SUBTYPES.has(subType);
    return { kind, subType, sshCapable: false, ownGroups: !agentManaged, inheritsHost: agentManaged };
  }

  return { kind, subType, sshCapable: false, ownGroups: true, inheritsHost: false };
}

// Which resources discovery may merge this one into.
//
// `kind` is structural (site / host / service) and deliberately coarse. Merge
// safety is finer than that: an out-of-band controller is a `host` in every
// structural sense -- it belongs in the tree, it gets access groups -- but its
// management NIC must never fold into the server's host row, or one device's
// address ends up on the other.
//
// Before this, the guard was implemented by giving iLOs a made-up
// `kind: 'bmc'`. That protected the merge and broke everything else keyed on
// kind, groupKind() included, so BMCs silently never got access groups.
const BMC_SUBTYPES = new Set(['bmc', 'ilo', 'idrac']);

function identityClassFor(resource) {
  const kind = (resource && resource.kind) || '';
  const subType = String((resource && resource.metadata && resource.metadata.subType) || '').toLowerCase();

  const tpl = cachedTemplate(subType);
  if (tpl && tpl.identityClass) return tpl.identityClass;
  if (BMC_SUBTYPES.has(subType)) return 'bmc';

  // Kinds that predate the vocabulary, normalised so an old row still matches
  // what a plugin emits today.
  if (kind === 'container') return 'service';
  if (kind === 'template' || kind === 'bmc' || kind === 'network_device') {
    return kind === 'bmc' ? 'bmc' : 'host';
  }
  return kind || 'host';
}

// hasLiveAgent reports whether a host resource has a `theta-agent` service
// child whose agent is still enrolled. The agent is bound to the service
// resource via `Agent.resourceId`; the host is never marked with metadata.agentId.
//
// `agentServiceIds` is a Set of resource ids that are enrolled theta-agent
// services. If it is missing or empty, no host qualifies.
function hasLiveAgent(resource, agentServiceIds, edges = []) {
  if (!resource || resource.kind !== 'host' || !agentServiceIds) return false;
  const childIds = new Set(edges.filter(e => e.parentId === resource.id).map(e => e.childId));
  if (childIds.size === 0) return false;
  const services = Array.isArray(agentServiceIds) ? new Set(agentServiceIds) : agentServiceIds;
  for (const cid of childIds) {
    if (services.has(cid)) return true;
  }
  return false;
}

// isJumpTarget: a host an operator should be able to SSH to through the jump
// host, given they have access to it at all.
//
// Installing the agent on a machine is itself the act of putting it under
// management -- it requires root on that machine and a join key from this
// Directory. Requiring a second, manual step before the machine can be reached
// through the jump host adds no security (the same operator can grant it) and
// is the reason a fleet of agent hosts showed exactly one jump target.
function isJumpTarget(resource, agentServiceIds, edges = []) {
  if (!resource || resource.kind !== 'host') return false;
  const t = templateFor(resource);
  if (!t.sshCapable) return false;
  return hasLiveAgent(resource, agentServiceIds, edges) || resource.metadata?.sshCapable === true;
}

module.exports = {
  templateFor,
  identityClassFor,
  refreshTemplateCache,
  _setTemplateCache,
  hasLiveAgent,
  isJumpTarget,
  SSH_CAPABLE_HOST_SUBTYPES,
  NEVER_SSH_SUBTYPES,
  AGENT_SERVICE_SUBTYPES
};
