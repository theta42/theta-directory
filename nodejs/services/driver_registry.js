'use strict';

const BaseDriver = require('../drivers/base_driver');
const ThetaAgentDriver = require('../drivers/theta_agent_driver');
const ProxmoxDriver = require('../drivers/proxmox_driver');
const DockerSocketDriver = require('../drivers/docker_socket_driver');
const DbDriver = require('../drivers/db_driver');
const NetworkDriver = require('../drivers/network_driver');
const K8sDriver = require('../drivers/k8s_driver');
const AgentManager = require('../utils/agent_manager');

/**
 * Registry & Resolution Engine for Subtype Management and Metrics Drivers.
 */
class DriverRegistry {
  constructor() {
    this.drivers = [];
    this.defaultDriver = new BaseDriver('unmanaged');
    this.initDefaultDrivers();
  }

  initDefaultDrivers() {
    this.thetaAgentDriver = new ThetaAgentDriver();
    this.proxmoxDriver = new ProxmoxDriver();
    this.dockerSocketDriver = new DockerSocketDriver();
    this.dbDriver = new DbDriver();
    this.networkDriver = new NetworkDriver();
    this.k8sDriver = new K8sDriver();

    // Register drivers in priority order
    this.register(this.thetaAgentDriver);
    this.register(this.proxmoxDriver);
    this.register(this.dockerSocketDriver);
    this.register(this.dbDriver);
    this.register(this.networkDriver);
    this.register(this.k8sDriver);
  }

  /**
   * Register a new subtype driver.
   * @param {BaseDriver} driver 
   */
  register(driver) {
    if (driver && typeof driver.getMetrics === 'function') {
      this.drivers.push(driver);
    }
  }

  /**
   * Resolve the best driver for a resource using the 4-tier resolution engine:
   * 1. Direct theta-agent (if agent connected)
   * 2. Subtype-specific driver (Proxmox, Docker, DB, Network, K8s)
   * 3. Parent Provider Fallback (e.g. Proxmox hypervisor host for un-agentized LXC/KVM guest)
   * 4. Unmanaged fallback
   * @param {Object} resource 
   * @returns {BaseDriver}
   */
  async resolveDriver(resource) {
    if (!resource) return this.defaultDriver;

    // 1. Direct Theta Agent Check
    const agent = await AgentManager.getAgentForResource(resource.id).catch(() => null);
    if (agent && agent.isOnline) {
      return this.thetaAgentDriver;
    }

    // 2. Specialized Subtype Driver Check
    for (const driver of this.drivers) {
      if (driver !== this.thetaAgentDriver && driver.supports(resource)) {
        return driver;
      }
    }

    // 3. Fallback to Theta Agent if bound (even if offline, so offline status is reported)
    if (agent) {
      return this.thetaAgentDriver;
    }

    // 4. Fallback to Proxmox driver if it's an LXC/KVM guest
    const subType = ((resource.metadata && resource.metadata.subType) || '').toLowerCase();
    if (['lxc', 'kvm'].includes(subType)) {
      return this.proxmoxDriver;
    }

    return this.defaultDriver;
  }

  /**
   * Get operational telemetry for a resource.
   */
  async getMetrics(resource, options = {}) {
    const driver = await this.resolveDriver(resource);
    return await driver.getMetrics(resource, options);
  }

  /**
   * Execute a management action on a resource.
   */
  async execAction(resource, action, params = {}) {
    const driver = await this.resolveDriver(resource);
    return await driver.execAction(resource, action, params);
  }

  /**
   * Retrieve recent logs for a resource.
   */
  async getLogs(resource, lines = 100) {
    const driver = await this.resolveDriver(resource);
    return await driver.getLogs(resource, lines);
  }
}

// Singleton instance
const registry = new DriverRegistry();
module.exports = registry;
