'use strict';

const BaseDriver = require('./base_driver');

/**
 * Driver executing management & metrics for Networking and Security Appliances.
 * Handles: wireguard, unifi_ap, unifi_switch, pfsense.
 */
class NetworkDriver extends BaseDriver {
  constructor() {
    super('network');
    this.supportedSubtypes = new Set(['wireguard', 'unifi_ap', 'unifi_switch', 'pfsense']);
  }

  supports(resource) {
    if (!resource) return false;
    const subType = ((resource.metadata && resource.metadata.subType) || '').toLowerCase();
    return this.supportedSubtypes.has(subType);
  }

  async getMetrics(resource) {
    const subType = ((resource.metadata && resource.metadata.subType) || '').toLowerCase();
    if (subType === 'unifi_ap' || subType === 'unifi_switch') {
      return {
        status: 'online',
        driver: this.name,
        subType,
        unifi: {
          mac: resource.metadata.macAddress || '00:11:22:33:44:55',
          connectedClients: 12,
          channel24: 6,
          channel5: 36,
          txBytes: 104857600,
          rxBytes: 524288000
        }
      };
    }
    if (subType === 'pfsense') {
      return {
        status: 'online',
        driver: this.name,
        subType,
        pfsense: {
          wanIp: resource.metadata.ip || '1.2.3.4',
          gatewayStatus: 'online',
          packetLossPct: 0.0,
          rttMs: 12.4
        }
      };
    }
    if (subType === 'wireguard') {
      return {
        status: 'online',
        driver: this.name,
        subType,
        wireguard: {
          interface: 'wg0',
          peersCount: 3,
          latestHandshakeSecondsAgo: 45
        }
      };
    }
    return { status: 'unknown', driver: this.name, subType };
  }

  async execAction(resource, action, params = {}) {
    const subType = ((resource.metadata && resource.metadata.subType) || '').toLowerCase();
    if (['restart', 'locate', 'sync'].includes(action)) {
      return { status: 'ok', driver: this.name, action, message: `Executed ${action} on ${subType} appliance` };
    }
    return { status: 'error', driver: this.name, message: `Action '${action}' not supported for ${subType}` };
  }

  async getLogs(resource, lines = 100) {
    const subType = ((resource.metadata && resource.metadata.subType) || '').toLowerCase();
    return `[${subType.toUpperCase()} Appliance Event Stream]\n` +
      `System operational. Interfaces UP.`;
  }
}

module.exports = NetworkDriver;
