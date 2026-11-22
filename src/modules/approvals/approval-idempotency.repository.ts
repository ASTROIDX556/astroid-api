import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface ReserveApprovalIdempotencyInput {
  principalId: string;
  operation: string;
  keyHash: string;
  requestHash: string;
  expiresAt: Date;
}

/**
 * Persistence for idempotency records of approval mutations. Shares the
 * `transaction_idempotency_records` store (the model is generic: principal,
 * operation, key fingerprint, response and expiry) with transaction
 * submissions, but scopes every key by its own `operation`.
 */
@Injectable()
export class ApprovalIdempotencyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(input: ReserveApprovalIdempotencyInput) {
    const identity = {
      principalId: input.principalId,
      operation: input.operation,
      keyHash: input.keyHash,
    };

    // An expired record is not a replay: drop it and let the request create a
    // fresh one.
    await this.prisma.transactionIdempotencyRecord.deleteMany({
      where: { ...identity, expiresAt: { lte: new Date() } },
    });

    try {
      const record = await this.prisma.transactionIdempotencyRecord.create({
        data: { ...input },
      });
      return { record, created: true };
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'P2002'
      ) {
        throw error;
      }

      const record = await this.prisma.transactionIdempotencyRecord.findUnique({
        where: { principalId_operation_keyHash: identity },
      });
      if (!record) throw error;
      return { record, created: false };
    }
  }

  complete(id: string, response: Prisma.InputJsonValue, expiresAt: Date) {
    return this.prisma.transactionIdempotencyRecord.update({
      where: { id },
      data: { status: 'COMPLETED', response, expiresAt },
    });
  }

  /** Removes a still-processing reservation so the key can be retried. */
  release(id: string) {
    return this.prisma.transactionIdempotencyRecord.deleteMany({
      where: { id, status: 'PROCESSING' },
    });
  }
}
