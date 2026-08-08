'use strict';

/**
 * Abstract Base Class for all Directory Resource Subtype Drivers.
 * Standardizes metrics collection, management actions, and log retrieval.
 */
class BaseDriver {
  constructor(name) {
    this.name = name || 'base';
  }

  /**
   * Check if this driver supports a given resource subtype.
   * @param {Object} resource 
   * @returns {boolean}
   */
  supports(resource) {
    return false;
  }

  /**
   * Collect real-time operational telemetry for a resource.
   * @param {Object} resource 
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  async getMetrics(resource, options = {}) {
    return {
      status: 'unknown',
      driver: this.name,
      message: 'Metrics not implemented for base driver'
    };
  }

  /**
   * Execute a management action on a resource (e.g. restart, stop, scrub, scale).
   * @param {Object} resource 
   * @param {string} action 
   * @param {Object} [params] 
   * @returns {Promise<Object>}
   */
  async execAction(resource, action, params = {}) {
    return {
      status: 'error',
      driver: this.name,
      message: `Action '${action}' not supported by ${this.name} driver`
    };
  }

  /**
   * Retrieve recent logs for a resource.
   * @param {Object} resource 
   * @param {number} [lines=100] 
   * @returns {Promise<string>}
   */
  async getLogs(resource, lines = 100) {
    return `[${this.name}] Logs not supported for this resource type.`;
  }
}

module.exports = BaseDriver;
