import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditHashService, AuditHashInput } from './audit-hash.service';
import { AUDIT_CHAIN_GENESIS, computeAuditEntryHash } from './audit-hash';

const first: AuditHashInput = {
  id: 'entry-1',
  organizationId: 'org-1',
  userId: 'actor-1',
  action: 'AGENT_CREATED',
  entity: 'Agent',
  entityId: 'agent-1',
  oldValue: null,
  newValue: { name: 'Finance Bot', flags: { enabled: true, mode: 'safe' } },
  ipAddress: '127.0.0.1',
  device: 'test',
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
};

describe('computeAuditEntryHash', () => {
  it('uses deterministic UTF-8 field order and stable nested JSON for SHA-256', () => {
    const entry = {
      id: 'entry-1',
      actor: 'actor-1',
      action: 'CREATED',
      target: { entity: 'Agent', id: 'agent-1' },
      timestamp: new Date('2025-01-02T03:04:05.000Z'),
      payload: {
        newValue: { b: 2, a: 1 },
        oldValue: null,
        ipAddress: null,
        device: null,
      },
    };

    expect(computeAuditEntryHash(entry, AUDIT_CHAIN_GENESIS)).toBe(
      'd50096f946da79acafbe036ad04f628ee6f00551ea22b5f500fd6fb41a85d95e',
    );
    expect(computeAuditEntryHash(entry, 'previous')).not.toBe(
      computeAuditEntryHash(entry, AUDIT_CHAIN_GENESIS),
    );
    expect(
      computeAuditEntryHash(
        { ...entry, payload: { ...entry.payload, newValue: { a: 1, b: 2 } } },
        AUDIT_CHAIN_GENESIS,
      ),
    ).toBe(computeAuditEntryHash(entry, AUDIT_CHAIN_GENESIS));
  });
});

describe('AuditHashService', () => {
  let prisma: {
    auditLog: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    auditLogArchive: { findFirst: ReturnType<typeof vi.fn> };
  };
  let service: AuditHashService;

  beforeEach(() => {
    prisma = {
      auditLog: { findFirst: vi.fn(), findMany: vi.fn() },
      auditLogArchive: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    service = new AuditHashService(
      prisma as unknown as import('../../database/prisma.service').PrismaService,
    );
  });

  it('builds and verifies a linked chain across multiple entries', async () => {
    const inputs = [
      first,
      { ...first, id: 'entry-2', action: 'AGENT_UPDATED', createdAt: new Date('2026-01-02T03:05:00Z') },
      { ...first, id: 'entry-3', action: 'AGENT_DELETED', createdAt: new Date('2026-01-02T03:06:00Z') },
    ];
    let prevHash = AUDIT_CHAIN_GENESIS;
    const entries = inputs.map((input) => {
      const result = service.computeEntryHash(input, prevHash);
      prevHash = result.hash;
      return { ...input, ...result };
    });
    prisma.auditLog.findMany.mockResolvedValue(entries);

    const result = await service.verifyChainIntegrity('org-1');
    expect(result).toMatchObject({ valid: true, totalChecked: 3 });
  });

  it('reports the first entry whose meaningful payload was changed', async () => {
    const originalHash = service.computeEntryHash(first, AUDIT_CHAIN_GENESIS);
    const changed = { ...first, id: 'entry-2', action: 'AGENT_UPDATED' };
    const changedHash = service.computeEntryHash(changed, originalHash.hash);
    prisma.auditLog.findMany.mockResolvedValue([
      { ...first, ...originalHash },
      { ...changed, ...changedHash, newValue: { name: 'tampered' } },
    ]);

    const result = await service.verifyChainIntegrity('org-1');
    expect(result).toMatchObject({
      valid: false,
      brokenAtEntryId: 'entry-2',
      brokenAtIndex: 1,
    });
  });

  it('treats unhashed pre-migration rows as a legacy segment', async () => {
    const next = { ...first, id: 'entry-after-legacy' };
    const hash = service.computeEntryHash(next, AUDIT_CHAIN_GENESIS);
    prisma.auditLog.findMany.mockResolvedValue([
      { ...first, hash: null, prevHash: null },
      { ...next, ...hash },
    ]);

    await expect(service.verifyChainIntegrity('org-1')).resolves.toMatchObject({
      valid: true,
      totalChecked: 1,
    });
  });

  it('continues to verify entries hashed by the pre-upgrade canonical format', async () => {
    const oldPayload = [
      'org:org-1',
      'user:actor-1',
      'action:AGENT_CREATED',
      'entity:Agent',
      'entityId:agent-1',
      'old:null',
      `new:${JSON.stringify(first.newValue)}`,
      'ip:127.0.0.1',
      'device:test',
      `ts:${first.createdAt.toISOString()}`,
      'prev:GENESIS',
    ].join('|');
    const oldHash = createHash('sha256').update(oldPayload, 'utf8').digest('hex');
    prisma.auditLog.findMany.mockResolvedValue([{ ...first, prevHash: null, hash: oldHash }]);

    await expect(service.verifyChainIntegrity('org-1')).resolves.toMatchObject({
      valid: true,
      totalChecked: 1,
    });
  });

  it('uses an archived hash as the first live entry anchor', async () => {
    prisma.auditLogArchive.findFirst.mockResolvedValue({ chainBoundaryHash: 'archive-hash' });
    const hash = service.computeEntryHash(first, 'archive-hash');
    prisma.auditLog.findMany.mockResolvedValue([{ ...first, ...hash }]);

    await expect(service.verifyChainIntegrity('org-1')).resolves.toMatchObject({ valid: true });
  });
});
