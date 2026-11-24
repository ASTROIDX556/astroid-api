import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { ApiKeyRepository } from './api-key.repository';
import { CreateApiKeyInput, RotateApiKeyInput } from './api-key.dto';
import { ConflictException, NotFoundException } from '../../common/exceptions/domain.exception';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';
import { generateApiKey, safeEqual, verifyArgon2, sha256 } from '../../utils/crypto.util';
import { DEFAULT_API_KEY_SCOPES } from '../../common/constants/scopes';
import { authConfig } from '../../config/auth.config';
import { AuditService } from '../audit/audit.service';

const SORTABLE = ['createdAt', 'name', 'lastUsedAt'];

/**
 * Issues and manages programmatic API keys. The raw secret is generated, shown
 * to the caller exactly once, and only its Argon2id hash is persisted. Keys can
 * never be recovered — only regenerated. Legacy SHA-256 hashes are supported for
 * backward compatibility during migration.
 */
@Injectable()
export class ApiKeyService {
  constructor(
    private readonly repository: ApiKeyRepository,
    @Optional() private readonly auditService?: AuditService,
    @Optional() @Inject(authConfig.KEY) private readonly authConfiguration?: ConfigType<typeof authConfig>,
  ) {}

  async create(organizationId: string, actorId: string, input: CreateApiKeyInput) {
    const { raw, prefix, hashedKey } = await generateApiKey('live');
    const lastFour = raw.slice(-4);
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 86_400_000)
      : null;

    const apiKey = await this.repository.create({
      organizationId,
      createdById: actorId,
      name: input.name,
      prefix,
      lastFour,
      status: 'active',
      hashedKey,
      scopes: input.scopes ?? [...DEFAULT_API_KEY_SCOPES],
      permissions: input.permissions,
      allowedIps: input.allowedIps || [],
      rateLimitPerMinute: input.rateLimitPerMinute ?? null,
      rateLimitPerDay: input.rateLimitPerDay ?? null,
      expiresAt,
    });

    // The raw key is returned ONCE here and never stored or logged.
    return {
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      lastFour: apiKey.lastFour ?? lastFour,
      scopes: apiKey.scopes,
      permissions: apiKey.permissions,
      rateLimitPerMinute: apiKey.rateLimitPerMinute,
      rateLimitPerDay: apiKey.rateLimitPerDay,
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
    return new Paginated(items, buildPaginationMeta(total, query));
  }

  async rotate(
    organizationId: string,
    actorId: string,
    id: string,
    input?: RotateApiKeyInput,
  ) {
    const now = new Date();
    const key = await this.repository.findById(organizationId, id);
    if (!key) {
      throw new NotFoundException('ApiKey', id);
    }
    if (key.createdById !== actorId) {
      throw new NotFoundException('ApiKey', id);
    }
    if (key.revokedAt || key.status === 'revoked') {
      throw new ConflictException('API key is already revoked');
    }
    if (key.status === 'rotating' || key.rotatedAt) {
      throw new ConflictException('API key is already being rotated');
    }
    if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) {
      throw new ConflictException('API key is expired');
    }

    const defaultGrace = this.authConfiguration?.apiKeyRotationGracePeriodSeconds ?? 86400;
    const gracePeriodSeconds = input?.gracePeriodSeconds ?? defaultGrace;
    const graceExpiresAt = new Date(now.getTime() + gracePeriodSeconds * 1000);
    const previousKeyExpiresAt =
      key.expiresAt && key.expiresAt.getTime() < graceExpiresAt.getTime()
        ? key.expiresAt
        : graceExpiresAt;

    const { raw, prefix, hashedKey } = await generateApiKey('live');
    const lastFour = raw.slice(-4);
    const newExpiresAt = input?.expiresInDays
      ? new Date(now.getTime() + input.expiresInDays * 86_400_000)
      : key.expiresAt;
    const replacement = {
      organizationId,
      createdById: actorId,
      name: key.name,
      prefix,
      lastFour,
      status: 'active',
      hashedKey,
      scopes: key.scopes,
      permissions: key.permissions,
      allowedIps: key.allowedIps,
      rateLimitPerMinute: key.rateLimitPerMinute,
      rateLimitPerDay: key.rateLimitPerDay,
      expiresAt: newExpiresAt,
    };

    const rotated = await this.repository.rotate(
      organizationId,
      key.id,
      actorId,
      replacement,
      now,
      previousKeyExpiresAt,
    );
    if (!rotated) {
      throw new ConflictException('API key is no longer active');
    }
    const newApiKey = rotated.replacement;

    return {
      id: newApiKey.id,
      name: newApiKey.name,
      prefix: newApiKey.prefix,
      lastFour: newApiKey.lastFour ?? lastFour,
      scopes: newApiKey.scopes,
      permissions: newApiKey.permissions,
      expiresAt: newApiKey.expiresAt,
      key: raw,
      previousKeyId: key.id,
      previousKeyExpiresAt,
    };
  }

  async revoke(organizationId: string, id: string, actorId?: string) {
    const key = await this.repository.findById(organizationId, id);
    if (!key) {
      throw new NotFoundException('ApiKey', id);
    }
    if (key.revokedAt || key.status === 'revoked') {
      throw new ConflictException('API key is already revoked');
    }
    await this.repository.revoke(id);

    if (this.auditService && actorId) {
      try {
        await this.auditService.record({
          organizationId,
          userId: actorId,
          action: 'API_KEY_REVOKED',
          entity: 'ApiKey',
          entityId: key.id,
          oldValue: { keyId: key.id, prefix: key.prefix },
          newValue: { revoked: true, revokedAt: new Date() },
        });
      } catch {
        // gracefully continue
      }
    }

    return { id, revoked: true };
  }

  /**
   * Verifies a presented raw key: matches by Argon2 hash (with SHA-256 fallback for legacy keys),
   * checks it is neither revoked nor expired, and updates lastUsedAt. Returns the owning key or null.
   */
  async verify(rawKey: string) {
    if (!rawKey || typeof rawKey !== 'string' || rawKey.trim().length === 0) {
      return null;
    }
    
    const trimmedKey = rawKey.trim();
    
    // The hash algorithm is not known before the key is found, so candidates are
    // looked up by their public prefix. Revoked and expired rows are excluded
    // by the repository, and re-checked below so a stale cache can never let a
    // dead key through.
    const keys = await this.repository.findAuthenticatableByPrefix(trimmedKey.slice(0, 14));
    
    for (const key of keys) {
      if (key.revokedAt || key.status === 'revoked') {
        continue;
      }
      const now = Date.now();
      if (key.expiresAt && key.expiresAt.getTime() <= now) {
        continue;
      }
      if (key.status === 'rotating' && (!key.previousKeyExpiresAt || key.previousKeyExpiresAt.getTime() <= now)) {
        continue;
      }
      
      // Try Argon2 verification first (new keys). Argon2id verification is a
      // constant-time comparison of the derived hash against the stored one.
      const isValidArgon2 = await verifyArgon2(key.hashedKey, trimmedKey);
      if (isValidArgon2) {
        await this.touchLastUsed(key.id);
        return key;
      }
      
      // Fallback to SHA-256 for legacy keys (backward compatibility). The
      // comparison is constant-time as well, so a legacy key is never
      // distinguishable from a wrong one by response timing.
      if (safeEqual(key.hashedKey, sha256(trimmedKey))) {
        await this.touchLastUsed(key.id);
        return key;
      }
    }
    
    return null;
  }

  /**
   * Records that a key was just used. A failure to persist the timestamp must
   * never turn a valid authentication into a rejection, so it is swallowed.
   */
  private async touchLastUsed(id: string): Promise<void> {
    try {
      await this.repository.touchLastUsed(id);
    } catch {
      // Gracefully continue even if updating lastUsedAt encounters an error
    }
  }
}
