import { Injectable } from '@nestjs/common';
import { ApiKey, Prisma } from '@prisma/client';
import { ApiKeyRepository } from './api-key.repository';
import { CreateApiKeyInput, UpdateApiKeyInput } from './api-key.dto';
import {
  ConflictException,
  DomainException,
  NotFoundException,
} from '../../common/exceptions/domain.exception';
import { ErrorCode } from '../../common/constants/error-codes';
import {
  API_KEY_SCOPE_VALUES,
  isApiKeyScope,
} from '../../common/constants/api-key-scopes';
import {
  cursorWhere,
  paginatePage,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/pagination';
import { generateApiKey, sha256 } from '../../utils/crypto.util';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import {
  apiKeyCreatedAudit,
  apiKeyRevokedAudit,
  apiKeyRotatedAudit,
  apiKeyUpdatedAudit,
} from './events/api-key-audit.events';

/**
 * Issues and manages programmatic API keys. The raw secret is generated, shown
 * to the caller exactly once, and only its SHA-256 hash is persisted. Keys can
 * never be recovered — only regenerated.
 *
 * Scopes are validated against the canonical list before persistence; unknown
 * values are rejected with a 400 that enumerates the allowed set (#539).
 */
@Injectable()
export class ApiKeyService {
  constructor(
    private readonly repository: ApiKeyRepository,
    private readonly eventBus: EventBusService,
  ) {}

  async create(organizationId: string, actorId: string, input: CreateApiKeyInput) {
    const scopes = this.validateScopes(input.scopes);
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
      scopes,
      allowedIps: input.allowedIps || [],
      expiresAt,
    });

    await this.eventBus.emit(DomainEventName.ApiKeyCreated, apiKeyCreatedAudit(apiKey), {
      organizationId,
      actorId,
      aggregateType: 'api_key',
      aggregateId: apiKey.id,
    });

    // The raw key is returned ONCE here and never stored or logged.
    return {
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      scopes: apiKey.scopes,
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
    const pagination = toPrismaPagination(query);
    const { items, total } = await this.repository.findManyAndCount(
      { ...where, ...cursorWhere(query.cursor) },
      pagination,
    );
    return paginatePage(items, total, query);
  }

  /** Updates mutable key metadata. The secret itself is never editable. */
  async update(organizationId: string, actorId: string, id: string, input: UpdateApiKeyInput) {
    const existing = await this.getOrThrow(organizationId, id);
    if (existing.revokedAt) {
      throw new ConflictException('API key is revoked and can no longer be updated');
    }

    const data: Prisma.ApiKeyUpdateInput = {};
    if (input.name !== undefined) {
      data.name = input.name;
    }
    if (input.allowedIps !== undefined) {
      data.allowedIps = input.allowedIps;
    }
    if (input.scopes !== undefined) {
      data.scopes = { set: this.validateScopes(input.scopes) };
    }

    const updated = await this.repository.update(id, data);
    await this.eventBus.emit(
      DomainEventName.ApiKeyUpdated,
      apiKeyUpdatedAudit(updated, existing),
      { organizationId, actorId, aggregateType: 'api_key', aggregateId: id },
    );
    return this.redact(updated);
  }

  /**
   * Rotates the secret while preserving the key's scopes, permissions, IP
   * allow-list and expiry. The new raw secret is returned exactly once.
   */
  async rotate(organizationId: string, actorId: string, id: string) {
    const existing = await this.getOrThrow(organizationId, id);
    if (existing.revokedAt) {
      throw new ConflictException('API key is revoked and can no longer be rotated');
    }

    const { raw, prefix, hashedKey } = generateApiKey('live');
    const updated = await this.repository.update(id, {
      prefix,
      hashedKey,
      lastUsedAt: null,
    });

    await this.eventBus.emit(
      DomainEventName.ApiKeyRotated,
      apiKeyRotatedAudit(updated, existing),
      { organizationId, actorId, aggregateType: 'api_key', aggregateId: id },
    );

    return { ...this.redact(updated), key: raw };
  }

  async revoke(organizationId: string, actorId: string, id: string) {
    const key = await this.getOrThrow(organizationId, id);
    if (key.revokedAt) {
      throw new ConflictException('API key is already revoked');
    }
    const revoked = await this.repository.revoke(id);
    await this.eventBus.emit(DomainEventName.ApiKeyRevoked, apiKeyRevokedAudit(revoked), {
      organizationId,
      actorId,
      aggregateType: 'api_key',
      aggregateId: id,
    });
    return { id, revoked: true };
  }

  /**
   * Verifies a presented raw key: matches by hash, checks it is neither revoked
   * nor expired, and updates lastUsedAt. Returns the owning key or null.
   */
  async verify(rawKey: string) {
    const key = await this.repository.findByHash(sha256(rawKey));
    if (!key || key.revokedAt) {
      return null;
    }
    if (key.expiresAt && key.expiresAt.getTime() < Date.now()) {
      return null;
    }
    await this.repository.touchLastUsed(key.id);
    return key;
  }

  private async getOrThrow(organizationId: string, id: string): Promise<ApiKey> {
    const key = await this.repository.findById(organizationId, id);
    if (!key) {
      throw new NotFoundException('ApiKey', id);
    }
    return key;
  }

  /** Rejects unknown scope strings with the full allowed set in the error. */
  private validateScopes(scopes: string[]): string[] {
    const unknown = scopes.filter((scope) => !isApiKeyScope(scope));
    if (unknown.length > 0) {
      throw new DomainException(
        ErrorCode.BAD_REQUEST,
        `Unknown API key scope(s): ${unknown.join(', ')}`,
        { unknown, allowed: API_KEY_SCOPE_VALUES },
      );
    }
    return Array.from(new Set(scopes)).sort();
  }

  /** Drops the hash before a key record leaves the service. */
  private redact(key: ApiKey): Omit<ApiKey, 'hashedKey'> {
    const { hashedKey: _hashedKey, ...safe } = key;
    return safe;
  }
}
