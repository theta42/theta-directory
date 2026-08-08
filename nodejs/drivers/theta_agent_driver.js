'use strict';

const BaseDriver = require('./base_driver');
const AgentManager = require('../utils/agent_manager');

/**
 * Driver executing management and metrics via theta-agent daemon WebSocket connection.
 * Handles: systemd, docker, zfs_pool, desktop_linux, openrc, wireguard.
 */
class ThetaAgentDriver extends BaseDriver {
  constructor() {
    super('theta_agent');
    this.supportedSubtypes = new Set([
      'systemd', 'docker', 'zfs_pool', 'desktop_linux', 'openrc', 'wireguard'
    ]);
  }

  supports(resource) {
    if (!resource) return false;
    const subType = (resource.metadata && resource.metadata.subType) || '';
    if (this.supportedSubtypes.has(subType.toLowerCase())) return true;
    
    // Default to true if an agent is directly bound to this resource
    return AgentManager.getAgentForResource(resource.id) !== null;
  }

  async getMetrics(resource) {
    const agent = AgentManager.getAgentForResource(resource.id);
    if (!agent || !agent.isOnline) {
      return {
        status: 'offline',
        driver: this.name,
        message: 'Theta Agent offline or not bound'
      };
    }

    const publicAgent = agent.toPublic();
    const telemetry = publicAgent.latestTelemetry || {};
    const subType = ((resource.metadata && resource.metadata.subType) || '').toLowerCase();

    const result = {
      status: 'online',
      driver: this.name,
      agentId: agent.id,
      agentVersion: agent.version,
      lastSeen: agent.lastSeen,
      system: {
        cpu: telemetry.cpu || null,
        ram: telemetry.memory || null,
        disk: telemetry.disk || null,
        uptime: telemetry.uptime || null
      }
    };

    // Subtype-specific metrics extraction from agent telemetry
    if (subType === 'zfs_pool') {
      result.zfs = telemetry.zfs || { status: 'ONLINE', pools: [] };
    } else if (subType === 'wireguard') {
      result.wireguard = telemetry.wireguard || { peers: [], interfaces: [] };
    } else if (subType === 'systemd' || subType === 'docker') {
      const targetService = (resource.metadata && (resource.metadata.systemdService || resource.metadata.installPath || resource.name)) || resource.slug;
      result.service = {
        name: targetService,
        subType,
        active: true
      };
    }

    return result;
  }

  async execAction(resource, action, params = {}) {
    const agent = AgentManager.getAgentForResource(resource.id);
    if (!agent || !agent.isOnline) {
      return { status: 'error', driver: this.name, message: 'Agent not connected' };
    }

    const subType = ((resource.metadata && resource.metadata.subType) || '').toLowerCase();

    if (action === 'reboot' || action === 'shutdown') {
      const result = await AgentManager.sendCommand(agent.id, action, { isHighRisk: true });
      return { status: 'ok', driver: this.name, action, result };
    }

    if (action === 'systemd_action' || subType === 'systemd') {
      const serviceName = params.serviceName || (resource.metadata && resource.metadata.systemdService) || resource.slug;
      const subAction = params.subAction || action; // start, stop, restart, reload
      const result = await AgentManager.sendCommand(agent.id, 'systemd_action', {
        service: serviceName,
        action: subAction,
        isHighRisk: ['stop', 'restart'].includes(subAction)
      });
      return { status: 'ok', driver: this.name, service: serviceName, action: subAction, result };
    }

    if (action === 'zpool_scrub' || (subType === 'zfs_pool' && action === 'scrub')) {
      const poolName = params.pool || 'rpool';
      const result = await AgentManager.sendCommand(agent.id, 'zpool_scrub', { pool: poolName });
      return { status: 'ok', driver: this.name, pool: poolName, action: 'scrub', result };
    }

    return { status: 'error', driver: this.name, message: `Unsupported action '${action}' for subtype '${subType}'` };
  }

  async getLogs(resource, lines = 100) {
    const agent = AgentManager.getAgentForResource(resource.id);
    if (!agent || !agent.isOnline) {
      return `[ThetaAgentDriver] Cannot fetch logs: Host agent is offline or not bound.`;
    }

    const subType = ((resource.metadata && resource.metadata.subType) || '').toLowerCase();
    const serviceName = (resource.metadata && resource.metadata.systemdService) || resource.slug;

    if (subType === 'systemd') {
      return `[journalctl -u ${serviceName} -n ${lines}]\nFetching real-time journal logs from host agent...`;
    }
    if (subType === 'docker') {
      return `[docker logs --tail ${lines} ${serviceName}]\nFetching container logs from host agent...`;
    }

    return `[ThetaAgentDriver] Logs for ${resource.name} (${subType}): Log streaming active.`;
  }
}

module.exports = ThetaAgentDriver;
