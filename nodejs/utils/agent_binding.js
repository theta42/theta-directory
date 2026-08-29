'use strict';

const crypto = require('crypto');

// The graph edges that tie a theta-agent enrolment to a machine.
//
// There is no `metadata.agentId` any more (docs/resources-reimagined.md §4,
// "Abstract Graph Relations"). An agent binds to a `theta-agent` SERVICE
// resource, and that service hangs under the host it runs on:
//
//     Site --hosts--> Host --hosts--> Service{subType: 'theta-agent'}
//                                          ^
//                                          |  Agent.resourceId
//
// Every question the rest of the system used to ask a metadata field -- "does
// this host have an agent", "which host is this agent on" -- is a walk of one
// edge, and it lives here rather than being re-implemented at each call site.
// It had been open-coded five times, in agent_manager (x3), api_agent and
// scheduler, which is how the two directions drifted apart in the first place.

const AGENT_SERVICE_SUBTYPE = 'theta-agent';

function isAgentService(resource) {
  return Boolean(
    resource &&
    resource.kind === 'service' &&
    resource.metadata &&
    resource.metadata.subType === AGENT_SERVICE_SUBTYPE
  );
}

// A stable, readable slug for the agent service under `host`. Host slugs are
// `host-<something>`; the service reads `svc-<something>-theta-agent`.
function agentServiceSlug(hostSlug) {
  return `svc-${String(hostSlug || 'host').replace(/^host-/, '')}-${AGENT_SERVICE_SUBTYPE}`;
}

// The theta-agent service child of `hostResource`, or null.
async function findAgentService(hostResource) {
  if (!hostResource) return null;
  const { Resource, ResourceEdge } = require('../models/resource');
  const edges = await ResourceEdge.list({ where: { parentId: hostResource.id } }).catch(() => []);
  for (const edge of edges) {
    const child = await Resource.get(edge.childId).catch(() => null);
    if (isAgentService(child)) return child;
  }
  return null;
}

// The theta-agent service child of `hostResource`, creating it if absent.
async function ensureAgentService(hostResource) {
  const existing = await findAgentService(hostResource);
  if (existing) return existing;

  const { Resource, ResourceEdge } = require('../models/resource');
  const service = await Resource.create({
    id: crypto.randomUUID(),
    kind: 'service',
    name: 'Theta Agent',
    slug: agentServiceSlug(hostResource.slug),
    metadata: { subType: AGENT_SERVICE_SUBTYPE, managed: true },
    created_on: Math.floor(Date.now() / 1000)
  });
  await ResourceEdge.create({
    id: crypto.randomUUID(),
    parentId: hostResource.id,
    childId: service.id,
    relation: 'hosts'
  });
  return service;
}

// The host an agent runs on: the parent of the agent's own service resource.
// Null when the agent is unbound, or bound to something that is not an agent
// service.
async function hostForAgent(agent) {
  if (!agent || !agent.resourceId) return null;
  const { Resource, ResourceEdge } = require('../models/resource');

  const service = await Resource.get(agent.resourceId).catch(() => null);
  if (!isAgentService(service)) return null;

  const edges = await ResourceEdge.list({ where: { childId: service.id } }).catch(() => []);
  for (const edge of edges) {
    const parent = await Resource.get(edge.parentId).catch(() => null);
    if (parent && parent.kind === 'host') return parent;
  }
  return null;
}

module.exports = {
  AGENT_SERVICE_SUBTYPE,
  isAgentService,
  agentServiceSlug,
  findAgentService,
  ensureAgentService,
  hostForAgent
};
