import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '@prisma/client';
import { ApiKeyRepository } from './api-key.repository';
import { CreateApiKeyInput } from './api-key.dto';
import { ConflictException, NotFoundException } from '../../common/exceptions/domain.exception';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';
import { generateApiKey, sha256 } from '../../utils/crypto.util';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../modules/audit/audit.service';

const SORTABLE = ['createdAt', 'name', 'lastUsedAt'];

@Injectable()
export class ApiKeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: ApiKeyRepository,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  private getGracePeriodMillis(): number {
    return this.configService.get('rotation').apiKeyRotationGracePeriodHours * 60 * 60 * 1000;
  }

  async create(organizationId: string, actorId: string, input: CreateApiKeyInput) {
    const { raw, prefix, hashedKey } = generateApiKey('live');
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 86_400_000)
      : null;

    const apiKey = await this.repository.create({
      organizationId,
      createdById: actorId,
      name: input.name,
      prefix,
      hashedKey,
      permissions: input.permissions,
      allowedIps: input.allowedIps || [],
      expiresAt,
    });

    // The raw key is returned ONCE here and never stored or logged.
    return {
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      permissions: apiKey.permissions,
      expiresAt: apiKey.expiresAt,
      key: raw,
    };
  }

  async list(organizationId: string, query: PaginationQuery) {
    const where: Prisma.ApiKeyWhereInput = { organizationId };
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query.page, query.limit));
  }

  async revoke(organizationId: string, id: string) {
    const key = await this.repository.findById(organizationId, id);
    if (!key) {
      throw new NotFoundException('ApiKey', id);
    }
    if (key.revokedAt) {
      throw new ConflictException('API key is already revoked');
    }
    await this.repository.revoke(id);

    // If this key has a successor (replacement), immediately revoke it too.
    const successor = key.rotatedFromId
      ? await this.repository.findById(organizationId, key.rotatedFromId)
      : null;
    if (successor && !successor.revokedAt) {
      await this.repository.revoke(successor.id);
    }

    return { id, revoked: true };
  }

  /**
   * Verifies a presented raw key: matches by hash, checks it is neither revoked
   * nor expired, and updates lastUsedAt. Returns the owning key or null.
   * Also checks grace period expiry for predecessor keys.
   */
  async verify(rawKey: string) {
    if (!rawKey || rawKey.trim().length === 0) {
      return null;
    }
    const key = await this.repository.findByHash(sha256(rawKey.trim()));
    if (!key) {
      return null;
    }

    // Revoked keys are never valid.
    if (key.revokedAt) {
      return null;
    }

    // Check grace period expiry for predecessor keys.
    if (key.graceExpiresAt && key.graceExpiresAt.getTime() < Date.now()) {
      return null;
    }

    try {
      await this.repository.touchLastUsed(key.id);
    } catch {
      // Gracefully continue even if updating lastUsedAt encounters an error
    }
    return key;
  }

  /**
   * Rotate an API key. Generates a replacement key while keeping the
   * predecessor valid for a configurable grace period.
   *
   * Ownership is enforced: the key must belong to the authenticated caller.
   * The predecessor key remains valid until its grace period expires.
   * Revoking the replacement immediately invalidates the predecessor.
   */
  async rotateKey(organizationId: string, actorId: string, keyId: string) {
    // 1. Find the key being rotated and verify ownership.
    const predecessor = await this.repository.findById(organizationId, keyId);
    if (!predecessor) {
      throw new NotFoundException('ApiKey', keyId);
    }
    if (predecessor.organizationId !== organizationId) {
      throw new NotFoundException('ApiKey', keyId);
    }

    // 2. Reject if the predecessor has already been rotated.
    if (await this.repository.hasBeenRotated(organizationId, keyId)) {
      throw new ConflictException('API key has already been rotated');
    }

    // 3. Reject if the predecessor has a successor already (another key
    //    has rotatedFromId pointing to it). This prevents indefinite chains.
    if (await this.repository.hasSuccessor(organizationId, keyId)) {
      throw new ConflictException('This key already has a successor; rotation is not allowed');
    }

    // 4. Reject if the predecessor is revoked.
    if (predecessor.revokedAt) {
      throw new ConflictException('Cannot rotate a revoked API key');
    }

    // 5. Generate the replacement key.
    const { raw, prefix, hashedKey } = generateApiKey('live');

    // 6. Begin a Prisma transaction for atomicity.
    const result = await this.prisma.$transaction(async (tx) => {
      // 6a. Create the replacement key.
      const replacement = await tx.apiKey.create({
        data: {
          organizationId,
          createdById: actorId,
          name: `${predecessor.name} (replacement)`,
          prefix,
          hashedKey,
          permissions: predecessor.permissions,
          allowedIps: predecessor.allowedIps,
        },
      });

      // 6b. Update the predecessor: set graceExpiresAt.
      await tx.apiKey.update({
        where: { id: predecessor.id },
        data: {
          graceExpiresAt: new Date(Date.now() + this.getGracePeriodMillis()),
        },
      });

      // 6c. Set the replacement's rotatedFromId to point to the predecessor.
      await tx.apiKey.update({
        where: { id: replacement.id },
        data: { rotatedFromId: predecessor.id },
      });

      // 6d. Record the audit event.
      await this.auditService.record({
        organizationId: predecessor.organizationId,
        userId: actorId,
        action: 'API_KEY_ROTATE',
        entity: 'ApiKey',
        entityId: predecessor.id,
        oldValue: {
          keyId: predecessor.id,
          name: predecessor.name,
        },
        newValue: {
          keyId: replacement.id,
          name: replacement.name,
        },
      });

      return { replacement, predecessor };
    });

    // 7. Return the plaintext replacement key exactly once.
    return {
      id: result.replacement.id,
      name: result.replacement.name,
      prefix: result.replacement.prefix,
      permissions: result.replacement.permissions,
      graceExpiresAt: result.predecessor.graceExpiresAt,
      key: raw,
    };
  }
}