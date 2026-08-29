#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Detect if we are already running inside a Docker container
const isDocker = fs.existsSync('/.dockerenv') ||
                 process.env.INSIDE_DOCKER === '1' ||
                 process.env.DOCKER_CONTAINER === '1' ||
                 (process.env.app_ldap__url && process.env.app_ldap__url.includes('ldap:389'));

if (isDocker) {
  // Inside Docker container: run Jest test suite directly
  const jestBin = path.join(__dirname, 'node_modules', '.bin', 'jest');
  const args = ['--forceExit', ...process.argv.slice(2)];
  const result = spawnSync(jestBin, args, {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' }
  });
  process.exit(result.status !== null ? result.status : 1);
} else {
  // On Host: spin up Docker Compose test environment (OpenLDAP + Redis + test-runner)
  console.log('[test] Running SSO Manager test suite with Docker OpenLDAP + Redis...');
  const composeFile = path.resolve(__dirname, '..', 'docker-compose.test.yml');
  const result = spawnSync('docker', [
    'compose', '-f', composeFile, 'up', '--build', '--abort-on-container-exit', '--exit-code-from', 'test-runner'
  ], {
    stdio: 'inherit',
    env: process.env
  });
  // Clean up containers and volumes after run
  spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v'], { stdio: 'ignore' });
  process.exit(result.status !== null ? result.status : 1);
}
