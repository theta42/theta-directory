'use strict';

const { runStateEvaluation, evaluateCondition } = require('../services/scheduler');
const { Resource, ResourceEdge } = require('../models/resource');
const { SubtypeTemplate } = require('../models/subtype_template');
const { Agent } = require('../models/agent');
const { PluginInstance } = require('../models/plugin_instance');

describe('runStateEvaluation', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('rule telemetry.cpu_usage_percent > 80 sets status warning', async () => {
    const updated = [];
    const resource = {
      id: 'r1',
      slug: 'host-test',
      kind: 'host',
      metadata: { subType: 'linux' },
      update: jest.fn(async (patch) => {
        Object.assign(resource, patch);
        resource.metadata = patch.metadata;
        updated.push(resource);
      })
    };

    jest.spyOn(SubtypeTemplate, 'list').mockResolvedValue([
      { slug: 'linux', name: 'Linux Server', target_kind: 'host', status_rules: [
        { condition: 'telemetry.cpu_usage_percent > 80', status: 'warning', message: 'High CPU' }
      ] }
    ]);
    jest.spyOn(Resource, 'list').mockResolvedValue([resource]);
    jest.spyOn(ResourceEdge, 'list').mockResolvedValue([]);
    jest.spyOn(Agent, 'list').mockResolvedValue([
      { id: 'a1', resourceId: 'r1', lastTelemetry: { cpu_usage_percent: 85 } }
    ]);
    jest.spyOn(PluginInstance, 'list').mockResolvedValue([]);

    await runStateEvaluation();

    expect(resource.update).toHaveBeenCalledTimes(1);
    expect(resource.metadata.status).toBe('warning');
    expect(resource.metadata.status_message).toBe('High CPU');
  });

  test('invalid/unsafe condition string is rejected and leaves status unknown', async () => {
    const updated = [];
    const resource = {
      id: 'r2',
      slug: 'host-test2',
      kind: 'host',
      metadata: { subType: 'linux' },
      update: jest.fn(async (patch) => {
        Object.assign(resource, patch);
        resource.metadata = patch.metadata;
        updated.push(resource);
      })
    };

    jest.spyOn(SubtypeTemplate, 'list').mockResolvedValue([
      { slug: 'linux', name: 'Linux Server', target_kind: 'host', status_rules: [
        { condition: 'process.exit()', status: 'critical', message: 'nope' }
      ] }
    ]);
    jest.spyOn(Resource, 'list').mockResolvedValue([resource]);
    jest.spyOn(ResourceEdge, 'list').mockResolvedValue([]);
    jest.spyOn(Agent, 'list').mockResolvedValue([]);
    jest.spyOn(PluginInstance, 'list').mockResolvedValue([]);

    await runStateEvaluation();

    // No matching rule; status stays unknown. Persistence should still happen
    // because initial status differs from default 'unknown'.
    expect(resource.update).toHaveBeenCalledTimes(1);
    expect(resource.metadata.status).toBe('unknown');
    expect(resource.metadata.status_message).toBe('');
  });

  test('changes are persisted only when status differs', async () => {
    const resource = {
      id: 'r3',
      slug: 'host-test3',
      kind: 'host',
      metadata: { subType: 'linux', status: 'warning', status_message: 'High CPU' },
      update: jest.fn().mockResolvedValue(true)
    };

    jest.spyOn(SubtypeTemplate, 'list').mockResolvedValue([
      { slug: 'linux', name: 'Linux Server', target_kind: 'host', status_rules: [
        { condition: 'telemetry.cpu_usage_percent > 80', status: 'warning', message: 'High CPU' }
      ] }
    ]);
    jest.spyOn(Resource, 'list').mockResolvedValue([resource]);
    jest.spyOn(ResourceEdge, 'list').mockResolvedValue([]);
    jest.spyOn(Agent, 'list').mockResolvedValue([
      { id: 'a1', resourceId: 'r3', lastTelemetry: { cpu_usage_percent: 85 } }
    ]);
    jest.spyOn(PluginInstance, 'list').mockResolvedValue([]);

    await runStateEvaluation();

    expect(resource.update).not.toHaveBeenCalled();
  });

  // Status rules are operator-editable rows in the database, so the evaluator
  // must never be able to construct or run code. Asserted behaviourally --
  // grepping the source for the literal 'new Function' also matched the
  // comment that explains why it is not used.
  test('no dynamic code construction in the scheduler', () => {
    const scheduler = require('../services/scheduler');
    expect(scheduler.runStateEvaluation).toBeDefined();

    const src = require('fs').readFileSync(require.resolve('../services/scheduler.js'), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/^\s*\/\/.*$/, ''))
      .join('\n');
    expect(code).not.toMatch(/new\s+Function/);
    expect(code).not.toMatch(/\beval\s*\(/);
  });

  test('a rule condition cannot reach out of its context', () => {
    const ctx = { metadata: {}, telemetry: {}, plugin: null, environment: null, bubbled_environment: null };
    for (const evil of [
      'process.exit(1)',
      'require("fs")',
      'this.constructor',
      'global.process',
    ]) {
      expect(() => evaluateCondition(evil, ctx)).toThrow();
    }

    // A path rooted at a REAL context key is allowed to parse, so the guard
    // there is different: property access is own-properties-only, and the
    // prototype chain reads as absent rather than handing back Object /
    // Function.
    for (const path of ['metadata.constructor', 'metadata.__proto__', 'telemetry.constructor.constructor']) {
      expect(evaluateCondition(`${path} == null`, ctx)).toBe(true);
    }
  });
});

describe('evaluateCondition', () => {
  test('evaluates dotted telemetry comparisons', () => {
    expect(evaluateCondition('telemetry.cpu_usage_percent > 80', {
      telemetry: { cpu_usage_percent: 85 }
    })).toBe(true);

    expect(evaluateCondition('telemetry.cpu_usage_percent > 80', {
      telemetry: { cpu_usage_percent: 50 }
    })).toBe(false);
  });

  test('rejects unknown context roots', () => {
    expect(() => evaluateCondition('process.exit()', {})).toThrow(/Unknown context root/);
  });

  test('rejects unexpected characters', () => {
    expect(() => evaluateCondition('telemetry.cpu_usage_percent > 80);', {})).toThrow();
  });

  test('supports compound boolean expressions with parentheses', () => {
    const context = {
      metadata: { status: 'ok' },
      telemetry: { cpu_usage_percent: 95, ram_usage_percent: 10 }
    };
    expect(evaluateCondition(
      'metadata.status == "ok" && (telemetry.cpu_usage_percent > 90 || telemetry.ram_usage_percent > 80)',
      context
    )).toBe(true);

    context.telemetry.cpu_usage_percent = 50;
    expect(evaluateCondition(
      'metadata.status == "ok" && (telemetry.cpu_usage_percent > 90 || telemetry.ram_usage_percent > 80)',
      context
    )).toBe(false);
  });
});
