'use strict';

const fs = require('fs');
const path = require('path');
const modelsPath = fs.existsSync(path.resolve(__dirname, './models')) ? path.resolve(__dirname, './models') : path.resolve(__dirname, '../models');
const { initORM } = require(modelsPath);
const { Resource } = require(path.join(modelsPath, 'resource'));
const { Agent } = require(path.join(modelsPath, 'agent'));
const { UserVerification } = require(path.join(modelsPath, 'verification'));
const crypto = require('crypto');

async function runBenchmark() {
  console.log('=== STARTING HIGH CONCURRENCY STRESS BENCHMARK ===');
  await initORM();

  const NUM_AGENTS = 50;
  const NUM_RESOURCES = 30;
  const startTime = Date.now();

  console.log(`Phase 1: Simulating ${NUM_AGENTS} concurrent Agent updates...`);
  const agentPromises = [];
  for (let i = 0; i < NUM_AGENTS; i++) {
    agentPromises.push((async (idx) => {
      const agentId = `bench-agent-${idx}-${crypto.randomUUID().slice(0, 8)}`;
      // Create or update agent
      const agent = await Agent.create({
        id: agentId,
        name: `bench-node-${idx}`,
        description: 'Benchmark stress test agent',
        tokenHash: crypto.randomBytes(32).toString('hex'),
        tokenPrefix: 'tkn_' + idx,
        version: 'v2.8.1',
        last_seen: Math.floor(Date.now() / 1000),
        last_ip: `10.1.100.${idx}`,
        lastDiscovery: {
          hostname: `bench-host-${idx}`,
          cpu: 'AMD EPYC 7763 64-Core',
          ram_total_gb: 128
        },
        lastTelemetry: {
          cpu_usage_percent: Math.random() * 100,
          ram_usage_percent: Math.random() * 100
        }
      });

      // Update telemetry
      await agent.update({
        lastTelemetry: {
          cpu_usage_percent: 42.0,
          ram_usage_percent: 50.0,
          timestamp: new Date().toISOString()
        }
      });
      return agent;
    })(i));
  }

  const createdAgents = await Promise.all(agentPromises);
  console.log(`Successfully completed ${createdAgents.length} concurrent agent writes.`);

  console.log(`Phase 2: Simulating ${NUM_RESOURCES} concurrent Resource creates & queries...`);
  const resPromises = [];
  for (let i = 0; i < NUM_RESOURCES; i++) {
    resPromises.push((async (idx) => {
      const res = await Resource.create({
        id: `bench-res-${idx}-${crypto.randomUUID().slice(0, 8)}`,
        kind: 'service',
        slug: `bench-svc-${idx}-${crypto.randomUUID().slice(0, 6)}`,
        name: `Benchmark Service ${idx}`,
        owner: 'admin',
        description: 'Concurrency stress test resource'
      });

      // Concurrent read
      await Resource.list();
      return res;
    })(i));
  }

  const createdResources = await Promise.all(resPromises);
  console.log(`Successfully completed ${createdResources.length} concurrent resource writes & reads.`);

  // Cleanup benchmark data
  console.log('Cleaning up benchmark rows...');
  for (const a of createdAgents) await a.delete().catch(() => {});
  for (const r of createdResources) await r.delete().catch(() => {});

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`=== BENCHMARK COMPLETED IN ${elapsed.toFixed(2)}s WITH 0 ERRORS ===`);
}

runBenchmark().catch(err => {
  console.error('BENCHMARK FAILED:', err);
  process.exit(1);
});
