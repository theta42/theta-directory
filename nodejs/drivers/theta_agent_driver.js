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

  // supports() is the synchronous predicate DriverRegistry calls while picking
  // a driver, so it can only answer from the resource itself.
  //
  // It used to end with `AgentManager.getAgentForResource(resource.id) !== null`
  // -- an ASYNC call with no await, so the comparison was against a Promise,
  // which is never null. This driver therefore claimed every resource in the
  // catalog. It happens to be harmless today (resolveDriver awaits the agent
  // lookup itself and never consults this method for the agent driver), but a
  // predicate that always says yes is a trap for the next caller.
  supports(resource) {
    if (!resource) return false;
    const subType = (resource.metadata && resource.metadata.subType) || '';
    if (this.supportedSubtypes.has(subType.toLowerCase())) return true;
    return false;
  }

  // The unit/container/process name to act on for a service resource.
  //
  // `serviceName` is the generic field the agent reconciler writes for every
  // subtype (agent_manager.js reconcileServicesFromTelemetry); systemdService
  // and dockerContainer are the legacy per-subtype fields kept for resources
  // created before it existed. Falling through to `resource.slug` -- which is
  // what this used to do first -- targets a name like
  // `svc-lxc-213-systemd-emby-server`, which is not a unit on any host, so
  // every start/stop/restart silently acted on nothing. The resource NAME is a
  // better last resort than its slug, because the reconciler sets it to the
  // real unit name.
  static serviceTarget(resource, params = {}) {
    const meta = (resource && resource.metadata) || {};
    return params.serviceName
      || meta.serviceName
      || meta.systemdService
      || meta.dockerContainer
      || (resource && resource.name)
      || (resource && resource.slug);
  }

  async getMetrics(resource) {
    const agent = await AgentManager.getAgentForResource(resource.id);
    if (!agent || !agent.isOnline) {
      return {
        status: 'offline',
        driver: this.name,
        message: 'Theta Agent offline or not bound'
      };
    }

    const publicAgent = (typeof agent.toPublic === 'function') ? agent.toPublic() : agent;
    const telemetry = publicAgent.latestTelemetry || {};
    const subType = ((resource.metadata && resource.metadata.subType) || '').toLowerCase();

    const result = {
      status: 'online',
      driver: this.name,
      agentId: publicAgent.id || agent.id,
      agentVersion: publicAgent.version || (telemetry && telemetry.version) || 'unknown',
      lastSeen: publicAgent.lastSeen,
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
      const targetService = (resource.metadata && (resource.metadata.serviceName || resource.metadata.systemdService || resource.metadata.dockerContainer || resource.metadata.installPath)) || resource.name || resource.slug;
      // Live status + resource usage come from the telemetry stream (per
      // registered service), falling back to active:true so a freshly created
      // resource still reads healthy before the next 30s tick lands.
      const live = (telemetry.services || []).find(s =>
        s.name === targetService || s.name === resource.name || s.name === (resource.metadata && resource.metadata.serviceName) || s.name === (resource.metadata && resource.metadata.systemdService) || s.name === (resource.metadata && resource.metadata.dockerContainer)
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
    const agent = await AgentManager.getAgentForResource(resource.id);
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
		// H7: these session-control commands mutate user state, so the agent
		// requires an Ed25519 signature on them (fail-closed). Sign them.
		}, true);
		return { status: 'ok', driver: this.name, action: subAction, result };
	}


    // Service lifecycle. `service_action` is the name the Directory UI sends;
    // `systemd_action` stays accepted because that is the wire command the
    // agent has always implemented and older callers use it directly.
    if (['service_action', 'systemd_action', 'start', 'stop', 'restart', 'reload'].includes(action)
        || ThetaAgentDriver.CONTROLLABLE_SUBTYPES.has(subType)) {
      const subAction = params.subAction
        || (['systemd_action', 'service_action'].includes(action) ? null : action);
      if (!ThetaAgentDriver.SERVICE_ACTIONS.has(subAction)) {
        return {
          status: 'error', driver: this.name,
          message: `Unsupported service action '${subAction || action}' -- use ${[...ThetaAgentDriver.SERVICE_ACTIONS].join(', ')}`
        };
      }
      if (!ThetaAgentDriver.CONTROLLABLE_SUBTYPES.has(subType)) {
        // A timer, a cron entry or a VM does not start and stop through
        // systemctl the way a unit does; saying so beats dispatching a command
        // that will fail on the host.
        return {
          status: 'error', driver: this.name,
          message: `'${subType || 'unknown'}' services cannot be controlled from here`
        };
      }
      const serviceName = ThetaAgentDriver.serviceTarget(resource, params);
      const result = await AgentManager.sendCommand(agent.id, 'systemd_action', {
        service: serviceName,
        subtype: subType,
        action: subAction,
        // stop and restart interrupt something that is running; start does not.
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
    const agent = await AgentManager.getAgentForResource(resource.id);
    if (!agent || !agent.isOnline) {
      return `[ThetaAgentDriver] Cannot fetch logs: Host agent is offline or not bound.`;
    }

    const subType = ((resource.metadata && resource.metadata.subType) || '').toLowerCase();
    const serviceName = ThetaAgentDriver.serviceTarget(resource);

    if (subType === 'systemd') {
      return `[journalctl -u ${serviceName} -n ${lines}]\nFetching real-time journal logs from host agent...`;
    }
    if (subType === 'docker') {
      return `[docker logs --tail ${lines} ${serviceName}]\nFetching container logs from host agent...`;
    }

    return `[ThetaAgentDriver] Logs for ${resource.name} (${subType}): Log streaming active.`;
  }
}

// Which service subtypes have a start/stop/restart that means something, and
// which verbs are allowed. Both are allowlists on purpose: the agent's
// ServiceControl runs `systemctl <action> <service>`, so an unconstrained
// action string is an argument-injection surface, and the UI must not offer a
// button for a subtype where pressing it can only fail.
ThetaAgentDriver.CONTROLLABLE_SUBTYPES = new Set(['systemd', 'docker', 'podman', 'openrc']);
ThetaAgentDriver.SERVICE_ACTIONS = new Set(['start', 'stop', 'restart', 'reload']);

module.exports = ThetaAgentDriver;
