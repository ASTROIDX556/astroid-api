import { describe, expect, it, vi } from 'vitest';
import { TransactionRepository } from './transaction.repository';
import { PrismaService } from '../../database/prisma.service';

describe('TransactionRepository idempotency reservation', () => {
  it('uses the database unique constraint result when concurrent requests race', async () => {
    const record = {
      id: 'record_1',
      principalId: 'principal_1',
      operation: 'transactions.create',
      keyHash: 'key-hash',
      requestHash: 'request-hash',
      status: 'PROCESSING',
      transactionId: null,
      response: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    let inserted = false;
    const prisma = {
      transactionIdempotencyRecord: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockImplementation(async () => {
          if (inserted) throw { code: 'P2002' };
          inserted = true;
          return record;
        }),
        findUnique: vi.fn().mockResolvedValue(record),
      },
    } as unknown as PrismaService;
    const repository = new TransactionRepository(prisma);
    const input = {
      principalId: 'principal_1',
      operation: 'transactions.create',
      keyHash: 'key-hash',
      requestHash: 'request-hash',
      expiresAt: new Date(Date.now() + 60_000),
    };

    const results = await Promise.all([
      repository.reserveIdempotencyKey(input),
      repository.reserveIdempotencyKey(input),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(1);
    expect(results[0].record.id).toBe(results[1].record.id);
    expect(prisma.transactionIdempotencyRecord.create).toHaveBeenCalledTimes(2);
  });
});