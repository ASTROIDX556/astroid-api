import { Injectable } from '@nestjs/common';
import { sha256 } from '../../utils/crypto.util';
import { PrismaService } from '../../database/prisma.service';

/**
 * Cryptographic hash chain service for tamper-evident audit logs.
 * Each audit entry includes the SHA-256 hash of the preceding record,
 * creating an immutable chain that detects any unauthorized modifications.
 */

export interface AuditHashInput {
  organizationId: string;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string | null;
  device?: string | null;
  createdAt?: Date;
}

export interface AuditHashResult {
  previousHash: string | null;
  hash: string;
}

export interface IntegrityCheckResult {
  valid: boolean;
  totalChecked: number;
  brokenAtEntryId: string | null;
  brokenAtIndex: number | null;
  message: string;
}

@Injectable()
export class AuditHashService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Computes the hash for an audit log entry based on its payload and the
   * previous entry's hash. The hash is deterministic given the same inputs.
   */
  computeEntryHash(
    input: AuditHashInput,
    previousHash: string | null,
  ): AuditHashResult {
    const canonicalPayload = this.buildCanonicalPayload(input, previousHash);
    const hash = sha256(canonicalPayload);

    return {
      previousHash,
      hash,
    };
  }

  /**
   * Retrieves the latest audit log entry hash for an organization.
   * This is used to chain the next entry.
   */
  async getLatestHash(organizationId: string): Promise<string | null> {
    const latest = await this.prisma.auditLog.findFirst({
      where: {
        organizationId,
        hash: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { hash: true },
    });

    return latest?.hash ?? null;
  }

  /**
   * Validates the integrity of the entire audit chain for an organization.
   * Traverses all entries and verifies each hash links correctly to the previous.
   */
  async verifyChainIntegrity(
    organizationId: string,
  ): Promise<IntegrityCheckResult> {
    const entries = await this.prisma.auditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        organizationId: true,
        userId: true,
        action: true,
        entity: true,
        entityId: true,
        oldValue: true,
        newValue: true,
        ipAddress: true,
        device: true,
        previousHash: true,
        hash: true,
        createdAt: true,
      },
    });

    let expectedPreviousHash: string | null = null;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      // Skip entries that don't have hash chain data (pre-migration)
      if (entry.hash === null) {
        continue;
      }

      // Check that the stored previousHash matches what we expect
      if (entry.previousHash !== expectedPreviousHash) {
        return {
          valid: false,
          totalChecked: i,
          brokenAtEntryId: entry.id,
          brokenAtIndex: i,
          message: `Chain broken at entry ${entry.id} (index ${i}): expected previousHash "${expectedPreviousHash}", got "${entry.previousHash}"`,
        };
      }

      // Recompute the hash and verify it matches the stored value
      const computed = this.computeEntryHash(
        {
          organizationId: entry.organizationId,
          userId: entry.userId,
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId,
          oldValue: entry.oldValue,
          newValue: entry.newValue,
          ipAddress: entry.ipAddress,
          device: entry.device,
          createdAt: entry.createdAt,
        },
        entry.previousHash,
      );

      if (computed.hash !== entry.hash) {
        return {
          valid: false,
          totalChecked: i,
          brokenAtEntryId: entry.id,
          brokenAtIndex: i,
          message: `Entry ${entry.id} (index ${i}) hash mismatch: expected "${computed.hash}", got "${entry.hash}"`,
        };
      }

      expectedPreviousHash = entry.hash;
    }

    return {
      valid: true,
      totalChecked: entries.length,
      brokenAtEntryId: null,
      brokenAtIndex: null,
      message: `Chain integrity verified: all ${entries.length} entries are valid`,
    };
  }

  /**
   * Validates a single audit log entry's hash.
   */
  async verifyEntryIntegrity(
    entryId: string,
    organizationId: string,
  ): Promise<{ valid: boolean; message: string }> {
    const entry = await this.prisma.auditLog.findFirst({
      where: { id: entryId, organizationId },
    });

    if (!entry) {
      return { valid: false, message: `Entry ${entryId} not found` };
    }

    if (entry.hash === null) {
      return {
        valid: false,
        message: `Entry ${entryId} has no hash (pre-migration entry)`,
      };
    }

    const computed = this.computeEntryHash(
      {
        organizationId: entry.organizationId,
        userId: entry.userId,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        ipAddress: entry.ipAddress,
        device: entry.device,
        createdAt: entry.createdAt,
      },
      entry.previousHash,
    );

    if (computed.hash !== entry.hash) {
      return {
        valid: false,
        message: `Entry ${entryId} hash mismatch: expected "${computed.hash}", got "${entry.hash}"`,
      };
    }

    return { valid: true, message: `Entry ${entryId} integrity verified` };
  }

  /**
   * Builds a canonical string representation of the audit entry for hashing.
   * The representation is deterministic and includes all fields that define
   * the entry's content, plus the previous hash to create the chain.
   */
  private buildCanonicalPayload(
    input: AuditHashInput,
    previousHash: string | null,
  ): string {
    const parts: string[] = [
      `org:${input.organizationId}`,
      `user:${input.userId ?? ''}`,
      `action:${input.action}`,
      `entity:${input.entity}`,
      `entityId:${input.entityId ?? ''}`,
      `old:${JSON.stringify(input.oldValue ?? null)}`,
      `new:${JSON.stringify(input.newValue ?? null)}`,
      `ip:${input.ipAddress ?? ''}`,
      `device:${input.device ?? ''}`,
      `ts:${input.createdAt ? input.createdAt.toISOString() : new Date().toISOString()}`,
      `prev:${previousHash ?? 'GENESIS'}`,
    ];

    return parts.join('|');
  }
}
