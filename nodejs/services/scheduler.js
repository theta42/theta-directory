'use strict';

// Discovery / plugin scheduler.
//
// Generalized from the one-shot discovery-plugin loader: plugin *types* live
// under nodejs/plugins/<category>/<type>.js (see services/plugin_registry.js),
// and configured, loadable/unloadable *instances* live in the PluginInstance
// table (models/plugin_instance.js). This module schedules enabled instances
// on cron via BullMQ JobSchedulers and runs them in a Worker.
//
// Each instance owns a stable JobScheduler id (`plugin:<instanceId>`) so load/
// unload can add/remove a single schedule without disturbing the others —
// `upsertJobScheduler`/`removeJobScheduler` (BullMQ v6) take that id directly.
//
// Per-instance secrets are merged in from OpenBao (utils/plugin_secrets.js) at
// run time; the plugin's run()/discover() receives the combined non-secret
// config + secret values as a single `config` object, exactly as the legacy
// static-config path did.

const { Queue, Worker } = require('bullmq');
const { DiscoveryReconciler } = require('./discovery_reconciler');
const pluginRegistry = require('./plugin_registry');
const pluginSecrets = require('../utils/plugin_secrets');
const { PluginInstance, STATUS } = require('../models/plugin_instance');
const Redis = require('ioredis');

// Ensure Redis connection works for BullMQ
const redisOpts = { maxRetriesPerRequest: null };
const connection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', redisOpts);

// TWO queues, deliberately.
//
// Plugin runs talk to hardware over the network: an unreachable Proxmox, an
// nmap scan of a /16, a UniFi controller that accepts the TCP connection and
// then says nothing. They are slow and they hang.
//
// Garbage collection and status evaluation are local database passes that must
// keep running regardless. They used to share this queue and its single worker,
// so ONE hung plugin stopped status evaluation for every resource in the
// directory -- every dot in the tree silently froze at its last value, with
// nothing in the UI to say why.
const discoveryQueue = new Queue('discovery', { connection });
const maintenanceQueue = new Queue('directory-maintenance', { connection });

const RUN = 'run_plugin';
const GC = 'garbage_collect';
const EVAL_STATES = 'eval_states';
function pluginSchedulerId(id) { return `plugin:${id}`; }

// A plugin that never returns must not hold the queue forever. Per-instance
// (PluginInstance.timeoutMs) so a deliberately long nmap sweep can have more
// room than a Redfish poll, with a default that is generous for an API call and
// still far short of "wedged until someone restarts the container".
const DEFAULT_PLUGIN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_PLUGIN_TIMEOUT_MS = 60 * 60 * 1000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const worker = new Worker('discovery', async job => {
  if (job.name === RUN) {
    await runPluginJob(job.data && job.data.instanceId);
  }
}, { connection });

const maintenanceWorker = new Worker('directory-maintenance', async job => {
  if (job.name === GC) {
    console.log('[Scheduler] Running garbage collection');
    await DiscoveryReconciler.garbageCollect();
  } else if (job.name === EVAL_STATES) {
    await runStateEvaluation();
  }
}, { connection });

for (const [name, w] of [['discovery', worker], ['maintenance', maintenanceWorker]]) {
  w.on('error', (err) => console.error(`[Scheduler] ${name} worker error:`, err.message));
}

// Safe expression evaluator for status-rule conditions -- see
// docs/status-rules.md for the language as an author sees it.
//
// Grammar: == != < <= > >= && || ! ( ), number/string/true/false/null
// literals, and dotted paths rooted at one of CONTEXT_ROOTS. Anything else is
// a SyntaxError, which is the point: rules come out of the database and are
// editable by any directory admin, so this must never be `new Function`.
const CONTEXT_ROOTS = new Set(['metadata', 'telemetry', 'plugin', 'environment', 'bubbled_environment']);
const LITERALS = { true: true, false: false, null: null };

// `!` is prefix and therefore right-associative: with the left-associative
// rule (pop while equal precedence) `!!x` pops the first `!` before its
// operand is on the stack and evaluates `!undefined`.
const RIGHT_ASSOC = new Set(['!']);

function evaluateCondition(expression, context) {
  if (typeof expression !== 'string') return false;
  const tokens = tokenize(expression);
  if (tokens.length === 0) return false;

  const output = [];
  const ops = [];
  const precedence = { '!': 5, '<': 4, '<=': 4, '>': 4, '>=': 4, '==': 3, '!=': 3, '&&': 2, '||': 1 };

  function applyOp(op) {
    if (op === '!') {
      if (output.length < 1) throw new SyntaxError('`!` has no operand');
      output.push(!output.pop());
      return;
    }
    if (output.length < 2) throw new SyntaxError('`' + op + '` is missing an operand');
    const b = output.pop();
    const a = output.pop();
    switch (op) {
      case '==': output.push(a == b); break;
      case '!=': output.push(a != b); break;
      case '<': output.push(a < b); break;
      case '<=': output.push(a <= b); break;
      case '>': output.push(a > b); break;
      case '>=': output.push(a >= b); break;
      case '&&': output.push(a && b); break;
      case '||': output.push(a || b); break;
      default: throw new SyntaxError('Unknown operator: ' + op);
    }
  }

  // Own properties only. Walking the prototype chain would hand a rule author
  // `metadata.constructor` -- and from there `constructor.constructor` is the
  // Function constructor. This evaluator has no call syntax so that is not
  // executable today, but the whole reason it exists is that status rules are
  // operator-editable data, and "not reachable yet" is not a security
  // property worth relying on.
  function resolvePath(parts) {
    let val = context;
    for (const part of parts) {
      if (val == null || typeof val !== 'object') return undefined;
      if (!Object.prototype.hasOwnProperty.call(val, part)) return undefined;
      val = val[part];
    }
    return val;
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === 'number' || tok.type === 'string' || tok.type === 'literal') {
      output.push(tok.value);
    } else if (tok.type === 'ident') {
      output.push(resolvePath(tok.value));
    } else if (tok.type === 'op') {
      while (ops.length > 0) {
        const top = ops[ops.length - 1];
        if (top === '(' || precedence[top] == null) break;
        const outranks = RIGHT_ASSOC.has(tok.value)
          ? precedence[top] > precedence[tok.value]
          : precedence[top] >= precedence[tok.value];
        if (!outranks) break;
        applyOp(ops.pop());
      }
      ops.push(tok.value);
    } else if (tok.type === 'paren') {
      if (tok.value === '(') {
        ops.push('(');
      } else {
        while (ops.length > 0 && ops[ops.length - 1] !== '(') applyOp(ops.pop());
        if (ops.length === 0) throw new SyntaxError('Mismatched parentheses');
        ops.pop();
      }
    } else {
      throw new SyntaxError('Unexpected token: ' + JSON.stringify(tok));
    }
  }

  while (ops.length > 0) {
    const op = ops.pop();
    if (op === '(' || op === ')') throw new SyntaxError('Mismatched parentheses');
    applyOp(op);
  }

  if (output.length !== 1) throw new SyntaxError('Invalid expression');
  return output[0];
}

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  const len = expr.length;

  while (i < len) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }

    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }

    const two = expr.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if (['<', '>', '!'].includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let val = '';
      let closed = false;
      while (j < len) {
        const c = expr[j];
        if (c === quote) { j++; closed = true; break; }
        if (c === '\\') {
          j++;
          if (j >= len) throw new SyntaxError('Unterminated string escape');
          const nxt = expr[j];
          if (nxt === 'n') val += '\n';
          else if (nxt === 't') val += '\t';
          else val += nxt;
          j++;
        } else {
          val += c;
          j++;
        }
      }
      if (!closed) throw new SyntaxError('Unterminated string literal');
      tokens.push({ type: 'string', value: val });
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(expr[i + 1]))) {
      let j = i;
      while (j < len && /[0-9.]/.test(expr[j])) j++;
      const numStr = expr.slice(i, j);
      if (numStr.split('.').length > 2) throw new SyntaxError('Invalid number');
      tokens.push({ type: 'number', value: Number(numStr) });
      i = j;
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < len && /[a-zA-Z0-9_.]/.test(expr[j])) j++;
      const ident = expr.slice(i, j);
      if (ident.startsWith('.') || ident.endsWith('.') || ident.includes('..')) {
        throw new SyntaxError('Invalid property path: ' + ident);
      }
      // `true`, `false` and `null` are values, not context paths. Without them
      // there is no way to write a catch-all fallback rule, and no way to ask
      // the single most useful question a rule has -- "did any telemetry
      // arrive at all?" (`telemetry.cpu_usage_percent == null`).
      if (Object.prototype.hasOwnProperty.call(LITERALS, ident)) {
        tokens.push({ type: 'literal', value: LITERALS[ident] });
        i = j;
        continue;
      }
      const parts = ident.split('.');
      if (!CONTEXT_ROOTS.has(parts[0])) {
        throw new SyntaxError(
          'Unknown context root "' + parts[0] + '" (expected one of: ' + [...CONTEXT_ROOTS].join(', ') + ')');
      }
      tokens.push({ type: 'ident', value: parts });
      i = j;
      continue;
    }

    throw new SyntaxError('Unexpected character: ' + ch);
  }

  return tokens;
}

// Asynchronously evaluate status for all resources based on telemetry,
// plugin state, and graph-bubbled environment metadata.
async function runStateEvaluation() {
  const { Resource, ResourceEdge, ENV_RANK } = require('../models/resource');
  const { SubtypeTemplate } = require('../models/subtype_template');
  const { Agent } = require('../models/agent');
  const { PluginInstance } = require('../models/plugin_instance');

  try {
    const [templates, resources, agents, edges, pluginInstances] = await Promise.all([
      SubtypeTemplate.list(),
      Resource.list(),
      Agent.list(),
      ResourceEdge.list().catch(() => []),
      PluginInstance.list().catch(() => [])
    ]);

    const rulesBySubtype = {};
    for (const t of templates) {
      if (t.status_rules && t.status_rules.length > 0) {
        rulesBySubtype[t.slug] = t.status_rules;
      }
    }

    if (Object.keys(rulesBySubtype).length === 0) return;

    // Map theta-agent service resource id -> agent.
    const agentByResourceId = {};
    for (const a of agents) {
      if (a.resourceId) agentByResourceId[a.resourceId] = a;
    }

    // Graph adjacency for ancestor/descent traversal.
    const byId = new Map(resources.map(r => [r.id, r]));
    const parentEdges = {};
    const childEdges = {};
    for (const e of edges) {
      if (!e.parentId || !e.childId) continue;
      (parentEdges[e.childId] ||= []).push(e.parentId);
      (childEdges[e.parentId] ||= []).push(e.childId);
    }

    // Plugin instances target resources through discovery_sources.
    const pluginStatusByResourceId = {};
    for (const pi of pluginInstances) {
      if (pi.lastStatus == null) continue;
      for (const r of resources) {
        const sources = r.metadata?.discovery_sources || [];
        if (sources.includes(pi.slug)) pluginStatusByResourceId[r.id] = pi.lastStatus;
      }
    }

    // The agent that speaks for a resource: the one bound to it, the one on its
    // theta-agent service child, or the one on the host it runs under.
    function findAgentForResource(r, visited = new Set()) {
      if (!r || visited.has(r.id)) return null;
      visited.add(r.id);

      if (agentByResourceId[r.id]) return agentByResourceId[r.id];

      if (r.kind === 'host') {
        for (const cid of childEdges[r.id] || []) {
          const child = byId.get(cid);
          if (child && child.metadata?.subType === 'theta-agent' && agentByResourceId[cid]) {
            return agentByResourceId[cid];
          }
        }
      }
      for (const pid of parentEdges[r.id] || []) {
        const parent = byId.get(pid);
        if (parent && parent.kind === 'host') {
          const agent = findAgentForResource(parent, visited);
          if (agent) return agent;
        }
      }
      return null;
    }

    // The most critical environment among this resource and everything UNDER
    // it -- the identical rule Resource.getGraph() applies, so a rule author
    // writing `bubbled_environment == 'prod'` gets the value the tree and the
    // API showed them.
    //
    // This used to build an object of merged ANCESTOR metadata under the same
    // name. That bubbled the wrong direction and was not even a string, so the
    // comparison every rule would naturally write was silently false forever.
    const envCache = new Map();
    function bubbledEnvironment(resourceId, visited = new Set()) {
      if (envCache.has(resourceId)) return envCache.get(resourceId);
      if (visited.has(resourceId)) return undefined;
      visited.add(resourceId);

      const r = byId.get(resourceId);
      if (!r) return undefined;

      let best = ENV_RANK[r.metadata?.environment] ? r.metadata.environment : undefined;
      for (const cid of childEdges[resourceId] || []) {
        const childEnv = bubbledEnvironment(cid, visited);
        if (ENV_RANK[childEnv] && (!best || ENV_RANK[childEnv] > ENV_RANK[best])) best = childEnv;
      }
      envCache.set(resourceId, best);
      return best;
    }

    for (const r of resources) {
      const subtype = r.metadata?.subType || r.metadata?.subtype;
      const rules = subtype ? rulesBySubtype[subtype] : null;
      if (!rules || rules.length === 0) continue;

      const agent = findAgentForResource(r);
      const context = {
        metadata: r.metadata || {},
        telemetry: agent?.lastTelemetry || {},
        // PluginInstance.lastStatus is a string, so `plugin` is a bare value
        // ('ok', 'error', ...) and not an object to walk into.
        plugin: pluginStatusByResourceId[r.id] || null,
        environment: r.metadata?.environment || null,
        bubbled_environment: bubbledEnvironment(r.id) || null
      };

      let newStatus = 'unknown';
      let newMessage = '';

      for (const rule of rules) {
        if (!rule.condition) continue;
        try {
          if (evaluateCondition(rule.condition, context)) {
            newStatus = rule.status || 'unknown';
            newMessage = rule.message || '';
            break;
          }
        } catch (e) {
          console.warn(`[Scheduler] Rejected unsafe rule condition "${rule.condition}" for resource ${r.slug}: ${e.message}`);
        }
      }

      if (r.metadata?.status !== newStatus || r.metadata?.status_message !== newMessage) {
        const md = { ...r.metadata, status: newStatus, status_message: newMessage };
        await r.update({ metadata: md, updated_on: Math.floor(Date.now() / 1000) }).catch((err) => {
          console.warn(`[Scheduler] Failed to persist status for ${r.slug}:`, err.message);
        });
      }
    }
  } catch (err) {
    console.error('[Scheduler] State evaluation failed:', err.message);
  }
}

// Run one plugin instance. Loads the row (skip silently if it was deleted or
// disabled after the job was enqueued), merges its OpenBao secrets into its
// config, calls the plugin's run()/discover(), and — for discovery plugins —
// reconciles the result into the resource graph under the instance's slug.
// Bookkeeping (lastRunAt/lastStatus/lastError) is stamped on the row so the UI
// can show run state without querying BullMQ.
// A discovery payload, checked before it reaches the reconciler.
//
// The reconciler writes to the resource graph. It used to be handed whatever a
// plugin returned, so a plugin that returned undefined, or an object with
// `resources` as a string, produced either a crash deep in the merge logic or a
// row with a slug of "undefined". Rejecting the payload here means the failure
// is attributed to the plugin, shows up on its instance page, and leaves the
// graph untouched.
//
// Rows that are individually malformed are DROPPED rather than failing the
// whole run: one bad guest out of fifty should not discard the other
// forty-nine. Anything dropped is reported so it is not silent.
const CANONICAL_KINDS = new Set(['site', 'host', 'service', 'oauth']);

function validateDiscoveryPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: `expected an object, got ${payload === undefined ? 'undefined' : typeof payload}` };
  }
  const resources = payload.resources;
  const edges = payload.edges === undefined ? [] : payload.edges;
  if (!Array.isArray(resources)) return { ok: false, error: '`resources` must be an array' };
  if (!Array.isArray(edges)) return { ok: false, error: '`edges` must be an array' };

  const dropped = [];
  const goodResources = [];
  const seenSlugs = new Set();
  for (const [i, r] of resources.entries()) {
    if (!r || typeof r !== 'object') { dropped.push(`resource[${i}]: not an object`); continue; }
    if (!r.slug || typeof r.slug !== 'string') { dropped.push(`resource[${i}]: missing slug`); continue; }
    if (seenSlugs.has(r.slug)) { dropped.push(`resource[${i}]: duplicate slug ${r.slug}`); continue; }
    if (r.kind && !CANONICAL_KINDS.has(r.kind)) {
      // kind is structural and closed. Everything a plugin wants to say about
      // WHAT a thing is belongs in metadata.subType, where the vocabulary lives.
      dropped.push(`resource[${i}] (${r.slug}): unknown kind '${r.kind}'`);
      continue;
    }
    if (r.metadata !== undefined && (typeof r.metadata !== 'object' || r.metadata === null || Array.isArray(r.metadata))) {
      dropped.push(`resource[${i}] (${r.slug}): metadata must be an object`);
      continue;
    }
    seenSlugs.add(r.slug);
    goodResources.push(r);
  }

  const goodEdges = [];
  for (const [i, e] of edges.entries()) {
    if (!e || typeof e !== 'object') { dropped.push(`edge[${i}]: not an object`); continue; }
    if (!e.parentSlug || !e.childSlug) { dropped.push(`edge[${i}]: needs parentSlug and childSlug`); continue; }
    if (e.parentSlug === e.childSlug) { dropped.push(`edge[${i}]: self-edge on ${e.parentSlug}`); continue; }
    goodEdges.push(e);
  }

  return { ok: true, payload: { ...payload, resources: goodResources, edges: goodEdges }, dropped };
}

async function runPluginJob(instanceId) {
  if (!instanceId) { console.warn('[Scheduler] run_plugin job with no instanceId'); return; }
  const instance = await PluginInstance.get(instanceId);
  if (!instance) { console.warn(`[Scheduler] instance ${instanceId} gone — skipping`); return; }
  if (!instance.enabled) { console.warn(`[Scheduler] instance ${instance.slug} (${instanceId}) disabled — skipping`); return; }

  let mod;
  try { mod = pluginRegistry.getModule(instance.pluginType); }
  catch (err) {
    console.error(`[Scheduler] instance ${instance.slug}: type ${instance.pluginType} unavailable:`, err.message);
    await instance.update({ lastRunAt: Date.now(), lastStatus: STATUS.ERROR, lastError: `plugin type unavailable: ${instance.pluginType}` });
    return;
  }

  const runFn = mod.run || mod.discover;
  if (typeof runFn !== 'function') {
    console.error(`[Scheduler] instance ${instance.slug}: type ${instance.pluginType} has no run()/discover()`);
    await instance.update({ lastRunAt: Date.now(), lastStatus: STATUS.ERROR, lastError: 'plugin type has no run()/discover()' });
    return;
  }

  console.log(`[Scheduler] Running plugin: ${instance.slug} (${instance.pluginType})`);
  await instance.update({ lastRunAt: Date.now(), lastStatus: STATUS.RUNNING, lastError: null, lastLog: null });
  let logs = [];
  try {
    const cfg = await pluginSecrets.mergeForRun(instance);
    cfg.log = (msg) => {
      logs.push(`[${new Date().toISOString()}] ${msg}`);
      console.log(`[Plugin ${instance.slug}] ${msg}`);
      if (logs.length > 1000) logs.shift();
    };
    const timeoutMs = Math.min(
      Number(instance.timeoutMs) > 0 ? Number(instance.timeoutMs) : DEFAULT_PLUGIN_TIMEOUT_MS,
      MAX_PLUGIN_TIMEOUT_MS);
    const payload = await withTimeout(
      Promise.resolve().then(() => runFn(cfg)), timeoutMs, `plugin ${instance.slug}`);

    if (instance.category === 'discovery') {
      const check = validateDiscoveryPayload(payload);
      if (!check.ok) throw new Error(`plugin returned an unusable payload: ${check.error}`);
      for (const problem of check.dropped) cfg.log(`dropped ${problem}`);
      await DiscoveryReconciler.reconcile(instance.slug, check.payload, cfg);
    }
    await instance.update({ lastStatus: STATUS.OK, lastError: null, lastLog: logs.join('\n') });
  } catch (err) {
    console.error(`[Scheduler] Plugin ${instance.slug} failed:`, err.message);
    await instance.update({ lastStatus: STATUS.ERROR, lastError: String(err.message || err), lastLog: logs.join('\n') });
  }
}

// Schedule one instance: upsert a repeatable JobScheduler keyed by its id. Does
// NOT trigger an immediate run — call runInstanceNow(id) separately for that
// (used on boot and on "load"). Safe to call repeatedly (upsert is idempotent
// and will update the cron if it changed).
async function scheduleInstance(instance) {
  if (!instance || !instance.id) return;
  if (!instance.enabled) { await unscheduleInstance(instance.id); return; }
  const cron = instance.cron || '0 * * * *';
  await discoveryQueue.upsertJobScheduler(pluginSchedulerId(instance.id), { pattern: cron }, {
    name: RUN,
    data: { instanceId: instance.id }
  });
  console.log(`[Scheduler] Scheduled instance ${instance.slug} with cron ${cron}`);
}

// Remove an instance's repeatable schedule. No-op if it had none.
async function unscheduleInstance(id) {
  if (!id) return;
  try { await discoveryQueue.removeJobScheduler(pluginSchedulerId(id)); }
  catch (err) { /* missing scheduler is fine */ }
}

// Enqueue a single immediate run for an instance (the "Run now" button / boot
// kick). Runs once regardless of enabled, on top of any schedule.
async function runInstanceNow(id) {
  if (!id) return;
  await discoveryQueue.add(RUN, { instanceId: id });
}

// One-time legacy migration: if the PluginInstance table is empty AND
// conf.discovery.plugins has entries (the old static-config shape), seed one
// instance per configured type and copy its secret fields into OpenBao. After
// the first boot, the table is non-empty and the static config is ignored.
// Idempotent (guarded by the empty-table check).
async function migrateLegacyPlugins(discoveryConfig) {
  const existing = await PluginInstance.list();
  if (existing && existing.length) return;

  const legacy = discoveryConfig && discoveryConfig.plugins;
  if (!legacy || typeof legacy !== 'object') return;
  const names = Object.keys(legacy);
  if (!names.length) return;

  console.log(`[Scheduler] Migrating ${names.length} legacy discovery plugin(s) to instances…`);
  for (const name of names) {
    const entry = legacy[name] || {};
    const manifest = pluginRegistry.getManifest(name);
    if (!manifest) {
      console.warn(`[Scheduler] legacy plugin '${name}' has no registered type — skipping`);
      continue;
    }
    // splitConfig keeps only declared configSchema fields and separates secret
    // from non-secret. Legacy `enabled`/`cron` are not in configSchema, so they
    // are dropped here and read from the entry directly below.
    const { config, secrets } = pluginRegistry.splitConfig(name, entry);
    const instance = await PluginInstance.create({
      pluginType: name,
      category: manifest.category,
      name: manifest.name,
      slug: name,
      enabled: entry.enabled !== false,
      cron: entry.cron || '0 * * * *',
      config,
      created_by: 'legacy-migration'
    });
    try {
      await pluginSecrets.write(instance.id, secrets);
      console.log(`[Scheduler] migrated '${name}' -> instance ${instance.id} (slug ${instance.slug})`);
    } catch (err) {
      // The instance row exists; if we can't write secrets (e.g. the sso-broker
      // policy predates theta-suite v1.30.1) the operator gets a clear error
      // from the API on edit, and the instance still runs with its non-secret
      // config. Don't delete the row — the operator just needs to re-run
      // setup.sh and edit/save the secrets.
      console.error(`[Scheduler] migrated '${name}' row but FAILED to write secrets:`, err.message);
      await instance.update({ lastStatus: STATUS.ERROR, lastError: `secret migration failed: ${err.message}` });
    }
  }
}

// Boot-time initialization: clear stale schedulers, schedule garbage collection,
// migrate any legacy static-config plugins, then schedule every enabled
// instance and kick one immediate run for each.
async function initScheduler(discoveryConfig) {
  // Clear stale plugin/gc schedulers from a previous boot. Other-named
  // schedulers (none in this app) are left alone.
  for (const q of [discoveryQueue, maintenanceQueue]) {
    try {
      const schedulers = await q.getJobSchedulers();
      for (const s of schedulers) {
        if (s.name === RUN || s.name === GC || s.name === EVAL_STATES) {
          await q.removeJobScheduler(s.key || s.id);
        }
      }
    } catch (e) {
      console.log('[Scheduler] Could not clear old job schedulers:', e.message);
    }
  }

  // Maintenance, on its own queue so a hung plugin cannot stop it.
  await maintenanceQueue.upsertJobScheduler(GC, { pattern: '0 0 * * *' }, { name: GC, data: {} });
  await maintenanceQueue.upsertJobScheduler(EVAL_STATES, { pattern: '* * * * *' }, { name: EVAL_STATES, data: {} });

  try {
    await migrateLegacyPlugins(discoveryConfig);
  } catch (err) {
    console.error('[Scheduler] legacy migration failed:', err.message);
  }

  const enabled = await PluginInstance.listEnabled();
  for (const instance of enabled) {
    await scheduleInstance(instance);
    await runInstanceNow(instance.id); // boot kick
  }
  console.log(`[Scheduler] initialized — ${enabled.length} instance(s) scheduled`);
}

module.exports = {
  initScheduler,
  scheduleInstance,
  unscheduleInstance,
  runInstanceNow,
  runStateEvaluation,
  evaluateCondition,
  validateDiscoveryPayload,
  withTimeout,
  discoveryQueue,
  maintenanceQueue,
  connection
};