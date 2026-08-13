'use strict';

const fetch = require('node-fetch');
const https = require('https');
const BaseDriver = require('./base_driver');
const { PluginInstance } = require('../models/plugin_instance');
const pluginSecrets = require('../utils/plugin_secrets');

const agent = new https.Agent({ rejectUnauthorized: false });

// Redfish ResetType values, keyed by the action name the resource's action
// panel sends. A subset of the full Redfish enum -- only the ones that make
// sense as a one-click button (no NMI/PushPowerButton here, those are
// diagnostic/simulate-the-physical-button actions, not day-to-day power ops).
const RESET_TYPES = {
  power_on: 'On',
  reboot: 'GracefulRestart',
  force_restart: 'ForceRestart',
  shutdown: 'GracefulShutdown',
  force_off: 'ForceOff',
};

/**
 * Driver for HP iLO (Redfish) management interfaces: real power state/health
 * polling and real power control, unlike the other subtype drivers in this
 * directory (proxmox/docker_socket/etc.), which are still stubs returning
 * fixed sample data pending real backend wiring.
 *
 * Credentials: an `ilo`-resource is matched back to the PluginInstance that
 * discovered it via `metadata.discovery_sources` (stamped by
 * DiscoveryReconciler.reconcile with the instance's slug) -- the same
 * url/username/password the discovery plugin already validated, read from
 * OpenBao the same way the scheduler does for a discovery run. This avoids
 * inventing a second place to store the same credential.
 */
class IloDriver extends BaseDriver {
  constructor() {
    super('ilo');
    this.supportedSubtypes = new Set(['ilo']);
  }

  supports(resource) {
    if (!resource) return false;
    const subType = ((resource.metadata && resource.metadata.subType) || '').toLowerCase();
    return this.supportedSubtypes.has(subType);
  }

  // Resolves {url, username, password} for a resource by walking
  // discovery_sources -> PluginInstance (slug match, pluginType 'ilo') ->
  // OpenBao secret. Returns null (not throws) when nothing resolves, so
  // getMetrics/execAction can report a clear "offline"/"error" status
  // instead of an unhandled exception reaching the API layer.
  async resolveConfig(resource) {
    const sources = (resource.metadata && resource.metadata.discovery_sources) || [];
    for (const slug of sources) {
      const instances = await PluginInstance.list({ where: { slug, pluginType: 'ilo' } }).catch(() => []);
      const instance = instances && instances[0];
      if (!instance) continue;
      const cfg = await pluginSecrets.mergeForRun(instance);
      if (cfg.url && cfg.username && cfg.password) return cfg;
    }
    return null;
  }

  async getMetrics(resource) {
    const cfg = await this.resolveConfig(resource);
    if (!cfg) {
      return { status: 'offline', driver: this.name, message: 'No iLO plugin instance found for this resource (was it discovered by the ilo plugin?)' };
    }
    try {
      const url = cfg.url.replace(/\/+$/, '');
      const headers = { Authorization: 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64') };
      const systemsRes = await fetch(`${url}/redfish/v1/Systems/`, { headers, agent });
      if (!systemsRes.ok) return { status: 'offline', driver: this.name, message: `Redfish Systems collection: HTTP ${systemsRes.status}` };
      const systemPath = ((await systemsRes.json()).Members || [])[0];
      if (!systemPath || !systemPath['@odata.id']) return { status: 'offline', driver: this.name, message: 'Redfish Systems collection returned no members' };
      const sysRes = await fetch(`${url}${systemPath['@odata.id']}`, { headers, agent });
      if (!sysRes.ok) return { status: 'offline', driver: this.name, message: `Redfish System read: HTTP ${sysRes.status}` };
      const system = await sysRes.json();
      return {
        status: 'online',
        driver: this.name,
        ilo: {
          powerState: system.PowerState || null,
          health: (system.Status && system.Status.Health) || null,
          state: (system.Status && system.Status.State) || null,
          model: system.Model || null,
          serial: system.SerialNumber || null,
        },
      };
    } catch (err) {
      return { status: 'error', driver: this.name, message: err.message };
    }
  }

  async execAction(resource, action, params = {}) {
    const resetType = RESET_TYPES[action];
    if (!resetType) {
      return { status: 'error', driver: this.name, message: `Unsupported iLO action '${action}' (supported: ${Object.keys(RESET_TYPES).join(', ')})` };
    }

    const cfg = await this.resolveConfig(resource);
    if (!cfg) {
      return { status: 'error', driver: this.name, message: 'No iLO plugin instance found for this resource (was it discovered by the ilo plugin?)' };
    }

    try {
      const url = cfg.url.replace(/\/+$/, '');
      const headers = { Authorization: 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64') };

      // The Reset action's real target URL is read off the System resource
      // rather than hardcoded -- Actions["#ComputerSystem.Reset"].target is
      // part of the Redfish contract precisely so a client never has to
      // guess it, and it is not guaranteed to be /Systems/1/Actions/... on
      // every iLO generation/config.
      const systemsRes = await fetch(`${url}/redfish/v1/Systems/`, { headers, agent });
      if (!systemsRes.ok) return { status: 'error', driver: this.name, message: `Redfish Systems collection: HTTP ${systemsRes.status}` };
      const systemPath = ((await systemsRes.json()).Members || [])[0];
      if (!systemPath || !systemPath['@odata.id']) return { status: 'error', driver: this.name, message: 'Redfish Systems collection returned no members' };
      const sysRes = await fetch(`${url}${systemPath['@odata.id']}`, { headers, agent });
      if (!sysRes.ok) return { status: 'error', driver: this.name, message: `Redfish System read: HTTP ${sysRes.status}` };
      const system = await sysRes.json();
      const resetAction = system.Actions && system.Actions['#ComputerSystem.Reset'];
      const target = resetAction && resetAction.target;
      if (!target) return { status: 'error', driver: this.name, message: 'This System has no ComputerSystem.Reset action available' };

      const resetRes = await fetch(`${url}${target}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ResetType: resetType }),
        agent,
      });
      if (!resetRes.ok) {
        const body = await resetRes.text().catch(() => '');
        return { status: 'error', driver: this.name, message: `Redfish Reset (${resetType}): HTTP ${resetRes.status} ${body}`.trim() };
      }
      return { status: 'ok', driver: this.name, action, resetType, message: `Dispatched Redfish ComputerSystem.Reset '${resetType}'` };
    } catch (err) {
      return { status: 'error', driver: this.name, message: err.message };
    }
  }

  async getLogs() {
    return `[ilo] Log streaming is not implemented -- read events from the iLO's own Integrated Management Log (Redfish LogServices) directly.`;
  }
}

module.exports = IloDriver;
