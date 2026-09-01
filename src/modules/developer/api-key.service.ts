import { Injectable } from '@nestjs/common';
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

const SORTABLE = ['createdAt', 'name', 'lastUsedAt'];

/**
 * Issues and manages programmatic API keys. The raw secret is generated, shown
 * to the caller exactly once, and only its SHA-256 hash is persisted. Keys can
 * never be recovered — only regenerated.
 */
@Injectable()
export class ApiKeyService {
  constructor(private readonly repository: ApiKeyRepository) {}

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
    return { id, revoked: true };
  }

  /**
   * Verifies a presented raw key: matches by hash, checks it is neither revoked
   * nor expired, and updates lastUsedAt. Returns the owning key or null.
   */
  async verify(rawKey: string) {
    if (!rawKey || typeof rawKey !== 'string' || rawKey.trim().length === 0) {
      return null;
    }
    const key = await this.repository.findByHash(sha256(rawKey.trim()));
    if (!key || key.revokedAt) {
      return null;
    }
    if (key.expiresAt && key.expiresAt.getTime() < Date.now()) {
      return null;
    }
    try {
      await this.repository.touchLastUsed(key.id);
    } catch {
      // Gracefully continue even if updating lastUsedAt encounters an error
    }
    return key;
  }
}
