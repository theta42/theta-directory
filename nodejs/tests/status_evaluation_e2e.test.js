'use strict';

// runStateEvaluation against a REAL graph in the real ORM.
//
// scheduler_state.test.js mocks the models, which is the right shape for
// testing the evaluator but leaves the join between them untested: whether the
// scheduler finds the agent through Host -> theta-agent service -> Agent, and
// whether `bubbled_environment` in a rule means the same thing it means in the
// tree. Both of those have been wrong before while every unit test passed.

require('./setup');
const crypto = require('crypto');
const { Resource, ResourceEdge } = require('../models/resource');
const { SubtypeTemplate } = require('../models/subtype_template');
const { Agent } = require('../models/agent');
const { runStateEvaluation } = require('../services/scheduler');

const uuid = () => crypto.randomUUID();

async function clearAll() {
  for (const e of await ResourceEdge.list()) await e.delete();
  for (const r of await Resource.list()) await r.delete();
  for (const t of await SubtypeTemplate.list()) await t.delete();
  for (const a of await Agent.list()) await a.delete();
}

async function res(kind, slug, metadata = {}) {
  return Resource.create({ id: uuid(), kind, name: slug, slug, metadata, created_on: 1 });
}
async function link(parent, child) {
  return ResourceEdge.create({ id: uuid(), parentId: parent.id, childId: child.id, relation: 'hosts' });
}
const statusOf = async (r) => (await Resource.get(r.id)).metadata.status;

describe('status evaluation over a real graph', () => {
  beforeEach(clearAll);
  afterAll(clearAll);

  test('telemetry reaches a host through its theta-agent service child', async () => {
    await SubtypeTemplate.create({
      id: uuid(), slug: 'linux', name: 'Linux', target_kind: 'host', created_on: 1,
      status_rules: [
        { condition: 'telemetry.cpu_usage_percent == null', status: 'unknown', message: 'No telemetry' },
        { condition: 'telemetry.cpu_usage_percent > 80', status: 'warning', message: 'High CPU' },
        { condition: 'true', status: 'ok', message: 'Healthy' }
      ]
    });

    const site = await res('site', 'site_e2e', { isCurrentSite: true });
    const busy = await res('host', 'host-busy', { subType: 'linux', managed: true });
    const idle = await res('host', 'host-idle', { subType: 'linux', managed: true });
    const lonely = await res('host', 'host-lonely', { subType: 'linux', managed: true });
    await link(site, busy); await link(site, idle); await link(site, lonely);

    const busySvc = await res('service', 'svc-busy-theta-agent', { subType: 'theta-agent' });
    const idleSvc = await res('service', 'svc-idle-theta-agent', { subType: 'theta-agent' });
    await link(busy, busySvc); await link(idle, idleSvc);

    await Agent.create({
      id: uuid(), name: 'busy', resourceId: busySvc.id, tokenHash: 'x',
      lastTelemetry: { cpu_usage_percent: 95 }
    });
    await Agent.create({
      id: uuid(), name: 'idle', resourceId: idleSvc.id, tokenHash: 'y',
      lastTelemetry: { cpu_usage_percent: 3 }
    });

    await runStateEvaluation();

    expect(await statusOf(busy)).toBe('warning');
    expect(await statusOf(idle)).toBe('ok');
    // No agent service under it at all: the honest answer is "no telemetry".
    expect(await statusOf(lonely)).toBe('unknown');
  });

  test('bubbled_environment in a rule is the string the tree shows', async () => {
    await SubtypeTemplate.create({
      id: uuid(), slug: 'linux', name: 'Linux', target_kind: 'host', created_on: 1,
      status_rules: [
        { condition: "bubbled_environment == 'prod'", status: 'critical', message: 'Carries production' },
        { condition: 'true', status: 'ok', message: 'Not production' }
      ]
    });

    const site = await res('site', 'site_env', { isCurrentSite: true });
    // The HOST is unclassified; the guest under it is prod. Environment bubbles
    // UP, so the host must read as prod too.
    const host = await res('host', 'host-parent', { subType: 'linux', managed: true });
    const guest = await res('host', 'host-guest', { subType: 'linux', managed: true, environment: 'prod' });
    const plain = await res('host', 'host-plain', { subType: 'linux', managed: true });
    await link(site, host); await link(host, guest); await link(site, plain);

    await runStateEvaluation();

    expect(await statusOf(guest)).toBe('critical');
    expect(await statusOf(host)).toBe('critical');
    expect(await statusOf(plain)).toBe('ok');

    // ...and the graph the UI renders agrees with the rule that just ran.
    const graph = await Resource.getGraph();
    const bySlug = Object.fromEntries(graph.resources.map(r => [r.slug, r]));
    expect(bySlug['host-parent'].metadata.bubbled_environment).toBe('prod');
    expect(bySlug['site_env'].metadata.bubbled_environment).toBe('prod');
    expect(bySlug['host-plain'].metadata.bubbled_environment).toBeUndefined();
  });

  test('a malformed rule is skipped without poisoning the others', async () => {
    await SubtypeTemplate.create({
      id: uuid(), slug: 'linux', name: 'Linux', target_kind: 'host', created_on: 1,
      status_rules: [
        { condition: 'process.exit(1)', status: 'critical', message: 'should never match' },
        { condition: 'true', status: 'ok', message: 'Healthy' }
      ]
    });
    const site = await res('site', 'site_bad', { isCurrentSite: true });
    const host = await res('host', 'host-bad-rule', { subType: 'linux', managed: true });
    await link(site, host);

    await runStateEvaluation();
    expect(await statusOf(host)).toBe('ok');
  });
});
