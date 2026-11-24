import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * Persistence for auth sessions.
 *
 * The refresh-token family operations are atomic so reuse detection and
 * rotation cannot race:
 *
 * - {@link consumeRefreshToken} is a conditional update (`consumedAt IS NULL`),
 *   so exactly one of any number of concurrent callers can consume a token.
 * - {@link revokeFamily} revokes every still-valid session of the family in a
 *   single transaction; once it resolves, no session of the family can be
 *   rotated or consumed by another caller.
 */
@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically marks a session's refresh token as consumed. Returns whether
   * THIS call consumed it: false when the session is missing, the presented
   * hash does not match the session's current hash (stale token), or the
   * token was already consumed (concurrent duplicate — the race case).
   */
  consumeRefreshToken(sessionId: string, presentedHash: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.session.updateMany({
        where: { id: sessionId, refreshTokenHash: presentedHash, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      return result.count === 1;
    });
  }

  /**
   * Revokes every still-valid session of a token family (idempotent).
   * Committed atomically: after this resolves, the family's refresh tokens
   * are unusable and their sessions rejected by the `revokedAt` check.
   */
  revokeFamily(familyId: string): Promise<void> {
    if (!familyId) {
      return Promise.resolve();
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }
}
