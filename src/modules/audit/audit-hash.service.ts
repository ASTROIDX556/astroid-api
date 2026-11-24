import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { AUDIT_CHAIN_GENESIS, computeAuditEntryHash } from './audit-hash';

export interface AuditHashInput {
  id: string;
  organizationId: string;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string | null;
  device?: string | null;
  createdAt: Date;
  prevHash?: string | null;
}

export interface AuditHashResult {
  prevHash: string;
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

  computeEntryHash(input: AuditHashInput, prevHash: string): AuditHashResult {
    const hash = computeAuditEntryHash(
      {
        id: input.id,
        actor: input.userId ?? null,
        action: input.action,
        target: { entity: input.entity, id: input.entityId ?? null },
        timestamp: input.createdAt,
        payload: {
          oldValue: input.oldValue ?? null,
          newValue: input.newValue ?? null,
          ipAddress: input.ipAddress ?? null,
          device: input.device ?? null,
        },
      },
      prevHash,
    );

    return { prevHash, hash };
  }

  async getLatestHash(organizationId: string): Promise<string | null> {
    const latest = await this.prisma.auditLog.findFirst({
      where: { organizationId, hash: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { hash: true },
    });

    return latest?.hash ?? null;
  }

  async verifyChainIntegrity(organizationId: string): Promise<IntegrityCheckResult> {
    const entries = await this.prisma.auditLog.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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
        prevHash: true,
        hash: true,
        createdAt: true,
      },
    });

    let expectedPreviousHash = await this.findArchiveAnchor(organizationId);
    let totalChecked = 0;

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.hash === null) {
        continue;
      }

      totalChecked += 1;
      const legacyHash = this.computeLegacyEntryHash(entry);
      const isLegacyHash = legacyHash === entry.hash;
      const expectedPrevHash = expectedPreviousHash ?? (isLegacyHash ? null : AUDIT_CHAIN_GENESIS);

      if (entry.prevHash !== expectedPrevHash) {
        return this.broken(
          entry.id,
          index,
          totalChecked - 1,
          `expected prevHash "${expectedPrevHash}", got "${entry.prevHash}"`,
        );
      }

      const computedHash = isLegacyHash
        ? legacyHash
        : this.computeEntryHash(entry, entry.prevHash ?? AUDIT_CHAIN_GENESIS).hash;
      if (computedHash !== entry.hash) {
        return this.broken(entry.id, index, totalChecked - 1, 'hash mismatch');
      }

      expectedPreviousHash = entry.hash;
    }

    return {
      valid: true,
      totalChecked,
      brokenAtEntryId: null,
      brokenAtIndex: null,
      message: `Chain integrity verified: all ${totalChecked} hashed entries are valid`,
    };
  }

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
      return { valid: false, message: `Entry ${entryId} has no hash (legacy entry)` };
    }

    const legacyHash = this.computeLegacyEntryHash(entry);
    const currentHash =
      entry.prevHash === null
        ? null
        : this.computeEntryHash(entry, entry.prevHash).hash;
    if (entry.hash !== legacyHash && entry.hash !== currentHash) {
      return { valid: false, message: `Entry ${entryId} hash mismatch` };
    }

    return { valid: true, message: `Entry ${entryId} integrity verified` };
  }

  private computeLegacyEntryHash(input: AuditHashInput): string {
    const payload = [
      `org:${input.organizationId}`,
      `user:${input.userId ?? ''}`,
      `action:${input.action}`,
      `entity:${input.entity}`,
      `entityId:${input.entityId ?? ''}`,
      `old:${JSON.stringify(input.oldValue ?? null)}`,
      `new:${JSON.stringify(input.newValue ?? null)}`,
      `ip:${input.ipAddress ?? ''}`,
      `device:${input.device ?? ''}`,
      `ts:${input.createdAt.toISOString()}`,
      `prev:${input.prevHash ?? 'GENESIS'}`,
    ].join('|');
    return createHash('sha256').update(payload, 'utf8').digest('hex');
  }

  private async findArchiveAnchor(organizationId: string): Promise<string | null> {
    const archive = await this.prisma.auditLogArchive.findFirst({
      where: { organizationId, chainBoundaryHash: { not: null } },
      orderBy: [{ archivedThrough: 'desc' }, { createdAt: 'desc' }],
      select: { chainBoundaryHash: true },
    });
    return archive?.chainBoundaryHash ?? null;
  }

  private broken(
    entryId: string,
    index: number,
    totalChecked: number,
    reason: string,
  ): IntegrityCheckResult {
    return {
      valid: false,
      totalChecked,
      brokenAtEntryId: entryId,
      brokenAtIndex: index,
      message: `Chain broken at entry ${entryId} (index ${index}): ${reason}`,
    };
  }
}
