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
      'systemd', 'docker', 'podman', 'process', 'systemd-timer', 'cron',
      'lxc', 'kvm', 'libvirt', 'zfs_pool', 'desktop_linux', 'openrc', 'wireguard'
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
      agentVersion: agent.version || (telemetry && telemetry.version) || 'unknown',
      lastSeen: agent.lastSeen,
      system: {
        cpu: telemetry.cpu || null,
        ram: telemetry.memory || null,
        disk: telemetry.disk || null,
        disks: telemetry.disks || [],
        loggedUsers: telemetry.loggedUsers || [],
        uptime: telemetry.uptime || null
      }
    };

    // Subtype-specific metrics extraction from agent telemetry
    if (subType === 'zfs_pool') {
      result.zfs = telemetry.zfs || { status: 'ONLINE', pools: [] };
    } else if (subType === 'wireguard') {
      result.wireguard = telemetry.wireguard || { peers: [], interfaces: [] };
    } else if (subType === 'systemd' || subType === 'docker' || subType === 'podman' || subType === 'process' || subType === 'systemd-timer' || subType === 'cron' || subType === 'lxc' || subType === 'kvm' || subType === 'libvirt') {
      const targetService = (resource.metadata && (resource.metadata.serviceName || resource.metadata.systemdService || resource.metadata.dockerContainer || resource.metadata.installPath || resource.name)) || resource.slug;
      // Live status + resource usage come from the telemetry stream (per
      // registered service), falling back to active:true so a freshly created
      // resource still reads healthy before the next 30s tick lands.
      const live = (telemetry.services || []).find(s =>
        s.name === targetService || s.name === (resource.metadata && resource.metadata.serviceName) || s.name === (resource.metadata && resource.metadata.systemdService) || s.name === (resource.metadata && resource.metadata.dockerContainer)
      );
      result.service = {
        name: targetService,
        subType,
        active: live ? !!live.active : true,
        registered: !!live,
        // Rich per-service metrics reported by the agent (telemetry.go).
        substate: live ? live.substate || null : null,
        load_state: live ? live.load_state || null : null,
        cpu_usage_percent: live && typeof live.cpu_usage_percent === 'number' ? live.cpu_usage_percent : null,
        memory_bytes: live && typeof live.memory_bytes === 'number' ? live.memory_bytes : null,
        n_restarts: live && typeof live.n_restarts === 'number' ? live.n_restarts : null,
        uptime_seconds: live && typeof live.uptime_seconds === 'number' ? live.uptime_seconds : null,
        // Schedule semantics (systemd-timer/cron).
        next_run: live ? live.next_run || null : null,
        last_run: live ? live.last_run || null : null,
        triggered_count: live && typeof live.triggered_count === 'number' ? live.triggered_count : null,
        // VM state (lxc/kvm/libvirt).
        status: live ? live.status || null : null
      };
    }

    // Any resource backed by this agent also exposes the agent's full list of
    // registered services (host-level view).
    if (Array.isArray(telemetry.services) && telemetry.services.length > 0) {
      result.registeredServices = telemetry.services;
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

    if (['desktop_control', 'lock_session', 'logout_user', 'display_off', 'sleep_host'].includes(action) || subType.startsWith('desktop')) {
      const subAction = params.subAction || action;
      const targetUser = params.user || '';
      const result = await AgentManager.sendCommand(agent.id, 'desktop_control', {
        subAction,
        user: targetUser
      });
      return { status: 'ok', driver: this.name, action: subAction, result };
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
