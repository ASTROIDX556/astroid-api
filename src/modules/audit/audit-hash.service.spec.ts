import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditHashService, AuditHashInput } from './audit-hash.service';

describe('AuditHashService', () => {
  let service: AuditHashService;
  let mockPrisma: {
    auditLog: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    mockPrisma = {
      auditLog: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
    };

    service = new AuditHashService(mockPrisma as unknown as import('../../database/prisma.service').PrismaService);
  });

  describe('computeEntryHash', () => {
    it('should compute a deterministic hash for the same input', () => {
      const input: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_INITIATED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 100 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:00:00Z'),
      };

      const result1 = service.computeEntryHash(input, null);
      const result2 = service.computeEntryHash(input, null);

      expect(result1.hash).toBe(result2.hash);
      expect(result1.previousHash).toBeNull();
    });

    it('should produce different hashes when inputs differ', () => {
      const input1: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_INITIATED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 100 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:00:00Z'),
      };

      const input2: AuditHashInput = {
        ...input1,
        newValue: { amount: 300 }, // Different value
      };

      const result1 = service.computeEntryHash(input1, null);
      const result2 = service.computeEntryHash(input2, null);

      expect(result1.hash).not.toBe(result2.hash);
    });

    it('should include previous hash in the chain', () => {
      const input: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_INITIATED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 100 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:00:00Z'),
      };

      const previousHash = 'abc123def456';
      const result = service.computeEntryHash(input, previousHash);

      expect(result.previousHash).toBe(previousHash);
      expect(result.hash).toBeDefined();
    });

    it('should produce valid SHA-256 hashes', () => {
      const input: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_INITIATED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 100 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:00:00Z'),
      };

      const result = service.computeEntryHash(input, null);

      // SHA-256 produces a 64-character hex string
      expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('getLatestHash', () => {
    it('should return the latest hash for an organization', async () => {
      mockPrisma.auditLog.findFirst.mockResolvedValueOnce({
        hash: 'latest-hash-123',
      });

      const result = await service.getLatestHash('org-123');

      expect(result).toBe('latest-hash-123');
      expect(mockPrisma.auditLog.findFirst).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-123',
          hash: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        select: { hash: true },
      });
    });

    it('should return null when no entries exist', async () => {
      mockPrisma.auditLog.findFirst.mockResolvedValueOnce(null);

      const result = await service.getLatestHash('org-123');

      expect(result).toBeNull();
    });
  });

  describe('verifyChainIntegrity', () => {
    it('should return valid for an empty chain', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValueOnce([]);

      const result = await service.verifyChainIntegrity('org-123');

      expect(result.valid).toBe(true);
      expect(result.totalChecked).toBe(0);
      expect(result.message).toContain('all 0 entries are valid');
    });

    it('should return valid for a chain with correct hashes', async () => {
      const entry1: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_INITIATED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 100 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:00:00Z'),
      };

      const entry2: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_COMPLETED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 200 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:05:00Z'),
      };

      const hash1 = service.computeEntryHash(entry1, null);
      const hash2 = service.computeEntryHash(entry2, hash1.hash);

      mockPrisma.auditLog.findMany.mockResolvedValueOnce([
        { ...entry1, ...hash1 },
        { ...entry2, ...hash2 },
      ]);

      const result = await service.verifyChainIntegrity('org-123');

      expect(result.valid).toBe(true);
      expect(result.totalChecked).toBe(2);
      expect(result.message).toContain('all 2 entries are valid');
    });

    it('should detect tampering when hash is modified', async () => {
      const entry1: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_INITIATED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 100 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:00:00Z'),
      };

      const entry2: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_COMPLETED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 200 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:05:00Z'),
      };

      const hash1 = service.computeEntryHash(entry1, null);
      const hash2 = service.computeEntryHash(entry2, hash1.hash);

      // Simulate tampering: modify the hash of entry 2
      const tamperedHash2 = 'tampered-hash-value';

      mockPrisma.auditLog.findMany.mockResolvedValueOnce([
        { id: 'entry-1', ...entry1, ...hash1 },
        { id: 'entry-2', ...entry2, ...hash2, hash: tamperedHash2 },
      ]);

      const result = await service.verifyChainIntegrity('org-123');

      expect(result.valid).toBe(false);
      expect(result.brokenAtEntryId).toBe('entry-2');
      expect(result.brokenAtIndex).toBe(1);
      expect(result.message).toContain('hash mismatch');
    });

    it('should detect tampering when previous hash link is broken', async () => {
      const entry1: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_INITIATED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 100 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:00:00Z'),
      };

      const entry2: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_COMPLETED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 200 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:05:00Z'),
      };

      const hash1 = service.computeEntryHash(entry1, null);
      const hash2 = service.computeEntryHash(entry2, hash1.hash);

      // Simulate tampering: break the previous hash link
      mockPrisma.auditLog.findMany.mockResolvedValueOnce([
        { id: 'entry-1', ...entry1, ...hash1 },
        { id: 'entry-2', ...entry2, ...hash2, previousHash: 'wrong-previous-hash' },
      ]);

      const result = await service.verifyChainIntegrity('org-123');

      expect(result.valid).toBe(false);
      expect(result.brokenAtEntryId).toBe('entry-2');
      expect(result.brokenAtIndex).toBe(1);
      expect(result.message).toContain('expected previousHash');
    });

    it('should skip entries without hash (pre-migration)', async () => {
      const entry1: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_INITIATED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 100 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:00:00Z'),
      };

      const entry2: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_COMPLETED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 200 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:05:00Z'),
      };

      const hash2 = service.computeEntryHash(entry2, null);

      mockPrisma.auditLog.findMany.mockResolvedValueOnce([
        { ...entry1, previousHash: null, hash: null }, // Pre-migration entry
        { ...entry2, ...hash2 },
      ]);

      const result = await service.verifyChainIntegrity('org-123');

      expect(result.valid).toBe(true);
      expect(result.totalChecked).toBe(2);
    });
  });

  describe('verifyEntryIntegrity', () => {
    it('should verify a valid entry', async () => {
      const input: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_INITIATED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 100 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:00:00Z'),
      };

      const hashResult = service.computeEntryHash(input, null);

      mockPrisma.auditLog.findFirst.mockResolvedValueOnce({
        id: 'entry-1',
        ...input,
        ...hashResult,
      });

      const result = await service.verifyEntryIntegrity('entry-1', 'org-123');

      expect(result.valid).toBe(true);
      expect(result.message).toContain('integrity verified');
    });

    it('should detect tampering in a single entry', async () => {
      const input: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_INITIATED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 100 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:00:00Z'),
      };

      const hashResult = service.computeEntryHash(input, null);

      // Simulate tampering: modify the stored hash
      mockPrisma.auditLog.findFirst.mockResolvedValueOnce({
        id: 'entry-1',
        ...input,
        ...hashResult,
        hash: 'tampered-hash',
      });

      const result = await service.verifyEntryIntegrity('entry-1', 'org-123');

      expect(result.valid).toBe(false);
      expect(result.message).toContain('hash mismatch');
    });

    it('should return error for non-existent entry', async () => {
      mockPrisma.auditLog.findFirst.mockResolvedValueOnce(null);

      const result = await service.verifyEntryIntegrity('entry-1', 'org-123');

      expect(result.valid).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should return error for pre-migration entry without hash', async () => {
      mockPrisma.auditLog.findFirst.mockResolvedValueOnce({
        id: 'entry-1',
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_INITIATED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 100 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:00:00Z'),
        previousHash: null,
        hash: null,
      });

      const result = await service.verifyEntryIntegrity('entry-1', 'org-123');

      expect(result.valid).toBe(false);
      expect(result.message).toContain('no hash');
    });
  });

  describe('hash chain properties', () => {
    it('should create a linked chain where each entry depends on the previous', () => {
      const entries: AuditHashInput[] = [
        {
          organizationId: 'org-123',
          userId: 'user-1',
          action: 'AGENT_CREATED',
          entity: 'Agent',
          entityId: 'agent-1',
          oldValue: null,
          newValue: { name: 'Finance Bot' },
          ipAddress: '127.0.0.1',
          device: 'Admin',
          createdAt: new Date('2026-08-30T10:00:00Z'),
        },
        {
          organizationId: 'org-123',
          userId: 'user-1',
          action: 'AGENT_WALLET_LINKED',
          entity: 'Wallet',
          entityId: 'wallet-1',
          oldValue: null,
          newValue: { agentId: 'agent-1' },
          ipAddress: '127.0.0.1',
          device: 'Admin',
          createdAt: new Date('2026-08-30T10:05:00Z'),
        },
        {
          organizationId: 'org-123',
          userId: 'user-2',
          action: 'AGENT_PAYMENT_INITIATED',
          entity: 'Transaction',
          entityId: 'tx-1',
          oldValue: { balance: 1000 },
          newValue: { balance: 800 },
          ipAddress: '10.0.0.1',
          device: 'AgentRunner/1.0',
          createdAt: new Date('2026-08-30T10:10:00Z'),
        },
      ];

      // Build the chain
      let previousHash: string | null = null;
      const hashes: string[] = [];

      for (const entry of entries) {
        const result = service.computeEntryHash(entry, previousHash);
        hashes.push(result.hash);
        previousHash = result.hash;
      }

      // Verify the chain is linked correctly
      expect(hashes).toHaveLength(3);
      expect(hashes[0]).not.toBe(hashes[1]);
      expect(hashes[1]).not.toBe(hashes[2]);

      // Each entry's hash should depend on the previous
      const entry1Hash = service.computeEntryHash(entries[0], null);
      expect(entry1Hash.hash).toBe(hashes[0]);

      const entry2Hash = service.computeEntryHash(entries[1], hashes[0]);
      expect(entry2Hash.hash).toBe(hashes[1]);

      const entry3Hash = service.computeEntryHash(entries[2], hashes[1]);
      expect(entry3Hash.hash).toBe(hashes[2]);
    });

    it('should make the chain immutable by detecting any modification', () => {
      const input: AuditHashInput = {
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_INITIATED',
        entity: 'Transaction',
        entityId: 'tx-1',
        oldValue: { amount: 100 },
        newValue: { amount: 200 },
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        createdAt: new Date('2026-08-30T10:00:00Z'),
      };

      const originalHash = service.computeEntryHash(input, null);

      // Try modifying each field and verify hash changes
      const modifications: Partial<AuditHashInput>[] = [
        { action: 'AGENT_PAYMENT_MODIFIED' },
        { entity: 'TransactionModified' },
        { entityId: 'tx-2' },
        { oldValue: { amount: 150 } },
        { newValue: { amount: 250 } },
        { ipAddress: '192.168.1.1' },
        { device: 'ModifiedAgent' },
      ];

      for (const mod of modifications) {
        const modifiedInput = { ...input, ...mod };
        const modifiedHash = service.computeEntryHash(modifiedInput, null);
        expect(modifiedHash.hash).not.toBe(originalHash.hash);
      }
    });
  });
});
