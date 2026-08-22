'use strict';

const { DirectoryJanitor } = require('../services/directory_janitor');
const { Resource, ResourceEdge } = require('../models/resource');
const { UserVerification } = require('../models/verification');
const { User } = require('../models/user');
const { Agent } = require('../models/agent');

describe('DirectoryJanitor Service', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('auditEdges removes edges with missing parent or child', async () => {
    const mockResources = [{ id: 'res-1' }, { id: 'res-2' }];
    const edgeDelete1 = jest.fn().mockResolvedValue(true);
    const edgeDelete2 = jest.fn().mockResolvedValue(true);

    const mockEdges = [
      { id: 'edge-valid', parentId: 'res-1', childId: 'res-2', delete: jest.fn() },
      { id: 'edge-bad-parent', parentId: 'res-999', childId: 'res-2', delete: edgeDelete1 },
      { id: 'edge-bad-child', parentId: 'res-1', childId: 'res-888', delete: edgeDelete2 }
    ];

    jest.spyOn(Resource, 'list').mockResolvedValue(mockResources);
    jest.spyOn(ResourceEdge, 'list').mockResolvedValue(mockEdges);

    const report = await DirectoryJanitor.auditEdges(true);
    expect(report.checked).toBe(3);
    expect(report.orphanedEdgesRemoved).toBe(2);
    expect(edgeDelete1).toHaveBeenCalledTimes(1);
    expect(edgeDelete2).toHaveBeenCalledTimes(1);
  });

  test('auditUsers creates verifications for users missing one and removes orphaned verifications', async () => {
    const mockUsers = [{ uid: 'alice' }, { uid: 'bob' }];
    const verRemove = jest.fn().mockResolvedValue(true);
    const mockVerifications = [
      { uid: 'alice' },
      { uid: 'charlie_deleted_user', remove: verRemove }
    ];

    jest.spyOn(User, 'list').mockResolvedValue(mockUsers);
    jest.spyOn(UserVerification, 'listDetail').mockResolvedValue(mockVerifications);
    jest.spyOn(UserVerification, 'get').mockImplementation(async (uid) => {
      if (uid === 'alice') return { uid: 'alice' };
      return null;
    });
    const verCreate = jest.spyOn(UserVerification, 'create').mockResolvedValue({});

    const report = await DirectoryJanitor.auditUsers(true);
    expect(report.checked).toBe(2);
    expect(report.missingVerificationsCreated).toBe(1);
    expect(verCreate).toHaveBeenCalledWith(expect.objectContaining({ uid: 'bob' }));
    expect(report.orphanedVerificationsCleaned).toBe(1);
    expect(verRemove).toHaveBeenCalledTimes(1);
  });

  test('auditAgents classifies online vs stale agents correctly', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const mockAgents = [
      { id: 'a1', last_seen: nowSec - 100 },
      { id: 'a2', last_seen: nowSec - 100000 } // > 24 hours ago
    ];

    jest.spyOn(Agent, 'list').mockResolvedValue(mockAgents);

    const report = await DirectoryJanitor.auditAgents(true);
    expect(report.total).toBe(2);
    expect(report.online).toBe(1);
    expect(report.stale).toBe(1);
  });

  test('runFullAudit returns full structured report', async () => {
    jest.spyOn(DirectoryJanitor, 'auditUsers').mockResolvedValue({ checked: 10 });
    jest.spyOn(DirectoryJanitor, 'auditEdges').mockResolvedValue({ checked: 5 });
    jest.spyOn(DirectoryJanitor, 'auditAgents').mockResolvedValue({ total: 2 });

    const full = await DirectoryJanitor.runFullAudit(true);
    expect(full.status).toBe('ok');
    expect(full.users.checked).toBe(10);
    expect(full.edges.checked).toBe(5);
    expect(full.agents.total).toBe(2);
  });
});
