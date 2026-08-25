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
const AGENT_SERVICE_SUBTYPES = new Set([
  'systemd', 'docker', 'podman', 'process', 'openrc', 'systemd-timer', 'cron'
]);

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

  if (kind === 'host') {
    const sshCapable = !NEVER_SSH_SUBTYPES.has(subType) && SSH_CAPABLE_HOST_SUBTYPES.has(subType);
    return { kind, subType, sshCapable, ownGroups: true, inheritsHost: false };
  }

  if (kind === 'service' || kind === 'container') {
    // Only services an AGENT registered inherit. A hand-created service
    // resource (the stack's own `sso-manager-<site>`, an OAuth-linked app) is a
    // catalog entry an operator chose to model, and taking its groups away
    // would silently change who can reach it.
    const agentManaged = Boolean(meta.agentId) && AGENT_SERVICE_SUBTYPES.has(subType);
    return { kind, subType, sshCapable: false, ownGroups: !agentManaged, inheritsHost: agentManaged };
  }

  return { kind, subType, sshCapable: false, ownGroups: true, inheritsHost: false };
}

// hasLiveAgent reports whether a host resource is bound to an agent that is
// still enrolled.
//
// The binding is recorded on the resource (metadata.agentId), but that field is
// NOT cleared when an agent is revoked or deleted -- and access must not
// outlive an enrolment. `activeAgentIds` is the set of agent ids that are still
// good; it is required, and an absent set means no host qualifies. A security
// predicate that defaults to permissive when its input is missing is the shape
// of bug this whole change is meant to remove, not add.
function hasLiveAgent(resource, activeAgentIds) {
  const id = resource && resource.metadata && resource.metadata.agentId;
  if (!id) return false;
  if (!activeAgentIds) return false;
  return activeAgentIds.has(id);
}

// isJumpTarget: a host an operator should be able to SSH to through the jump
// host, given they have access to it at all.
//
// Installing the agent on a machine is itself the act of putting it under
// management -- it requires root on that machine and a join key from this
// Directory. Requiring a second, manual step before the machine can be reached
// through the jump host adds no security (the same operator can grant it) and
// is the reason a fleet of agent hosts showed exactly one jump target.
function isJumpTarget(resource, activeAgentIds) {
  if (!resource || resource.kind !== 'host') return false;
  const t = templateFor(resource);
  if (!t.sshCapable) return false;
  return hasLiveAgent(resource, activeAgentIds) || resource.metadata?.sshCapable === true;
}

module.exports = {
  templateFor,
  hasLiveAgent,
  isJumpTarget,
  SSH_CAPABLE_HOST_SUBTYPES,
  NEVER_SSH_SUBTYPES,
  AGENT_SERVICE_SUBTYPES
};
