'use strict';

const { User } = require('../models/user');
const { UserVerification } = require('../models/verification');
const { Resource, ResourceEdge } = require('../models/resource');
const { Agent } = require('../models/agent');

class DirectoryJanitor {
  static async auditUsers(heal = true) {
    const report = { checked: 0, missingVerificationsCreated: 0, orphanedVerificationsCleaned: 0 };
    try {
      const users = await User.list({ detail: true }).catch(() => []);
      const userUids = new Set(users.map(u => u.uid).filter(Boolean));
      report.checked = users.length;

      for (const u of users) {
        if (!u.uid) continue;
        const ver = await UserVerification.get(u.uid).catch(() => null);
        if (!ver) {
          if (heal) {
            await UserVerification.create({
              uid: u.uid,
              created_by: u.uid,
              email_verified: false,
              tos_accepted: false
            }).catch(() => {});
            report.missingVerificationsCreated++;
          }
        }
      }

      const allVers = await UserVerification.listDetail().catch(() => []);
      for (const v of allVers) {
        if (v && v.uid && !userUids.has(v.uid)) {
          if (heal) {
            if (typeof v.remove === 'function') {
              await v.remove().catch(() => {});
            }
            report.orphanedVerificationsCleaned++;
          }
        }
      }
    } catch (e) {
      report.error = e.message;
    }
    return report;
  }

  static async auditEdges(heal = true) {
    const report = { checked: 0, orphanedEdgesRemoved: 0 };
    try {
      const allResources = await Resource.list().catch(() => []);
      const resIds = new Set(allResources.map(r => r.id));
      const edges = await ResourceEdge.list().catch(() => []);
      report.checked = edges.length;

      for (const edge of edges) {
        const parentExists = resIds.has(edge.parentId);
        const childExists = resIds.has(edge.childId);
        if (!parentExists || !childExists) {
          if (heal) {
            await edge.delete().catch(() => {});
            report.orphanedEdgesRemoved++;
          }
        }
      }
    } catch (e) {
      report.error = e.message;
    }
    return report;
  }

  static async auditAgents(heal = true) {
    const report = { total: 0, online: 0, stale: 0 };
    try {
      const agents = await Agent.list().catch(() => []);
      report.total = agents.length;
      const nowSec = Math.floor(Date.now() / 1000);
      const STALE_THRESHOLD_SEC = 24 * 3600; // 24 hours

      for (const a of agents) {
        const lastSeen = a.last_seen || 0;
        if (nowSec - lastSeen > STALE_THRESHOLD_SEC) {
          report.stale++;
        } else {
          report.online++;
        }
      }
    } catch (e) {
      report.error = e.message;
    }
    return report;
  }

  static async runFullAudit(heal = true) {
    const userReport = await this.auditUsers(heal);
    const edgeReport = await this.auditEdges(heal);
    const agentReport = await this.auditAgents(heal);

    return {
      timestamp: new Date().toISOString(),
      healApplied: heal,
      users: userReport,
      edges: edgeReport,
      agents: agentReport,
      status: 'ok'
    };
  }
}

module.exports = { DirectoryJanitor };
