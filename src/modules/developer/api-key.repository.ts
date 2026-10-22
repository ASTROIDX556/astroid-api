import { Injectable } from '@nestjs/common';
import { ApiKey, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

/**
 * Persistence for ApiKey rows. Only the Argon2id `hashedKey` is ever stored — the
 * raw key exists solely in the create response. Legacy SHA-256 hashes are supported
 * for backward compatibility during migration.
 */
@Injectable()
export class ApiKeyRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.ApiKeyUncheckedCreateInput): Promise<ApiKey> {
    return this.prisma.apiKey.create({ data });
  }

  async findManyAndCount(where: Prisma.ApiKeyWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.apiKey.findMany({
        where,
        ...pagination,
        // hashedKey is intentionally omitted from list responses.
        select: {
          id: true,
          organizationId: true,
          createdById: true,
          name: true,
          prefix: true,
          permissions: true,
          allowedIps: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
        },
      }),
      this.prisma.apiKey.count({ where }),
    ]);
    return { items, total };
  }

  findById(organizationId: string, id: string): Promise<ApiKey | null> {
    return this.prisma.apiKey.findFirst({ where: { id, organizationId } });
  }

  /** Resolves a presented key by its hash (used for API-key authentication). */
  findByHash(hashedKey: string): Promise<ApiKey | null> {
    return this.prisma.apiKey.findUnique({ where: { hashedKey } });
  }

  /**
   * Resolves the candidate keys for a presented key by its public prefix,
   * keeping only the rows that could still authenticate a request: not
   * revoked and not expired.
   *
   * The authentication path looks the key up by prefix (the hash algorithm is
   * not known before the key is found), so revoked and expired rows are
   * filtered out in the database instead of being loaded and rejected one by
   * one — a revoked key never reaches the deliberately expensive hash
   * verification.
   */
  findActiveByPrefix(prefix: string, now: Date = new Date()): Promise<ApiKey[]> {
    return this.prisma.apiKey.findMany({
      where: {
        prefix,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
  }

  /** Resolves API keys by their prefix (used for key verification with multiple hash algorithms). */
  findByPrefix(prefix: string): Promise<ApiKey[]> {
    return this.prisma.apiKey.findMany({ where: { prefix } });
  }

  revoke(id: string): Promise<ApiKey> {
    return this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  }

  touchLastUsed(id: string): Promise<ApiKey> {
    return this.prisma.apiKey.update({ where: { id }, data: { lastUsedAt: new Date() } });
  }
}
