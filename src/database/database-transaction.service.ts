import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PrismaTransactionService,
  TransactionOptions,
} from './prisma-transaction.service';

/**
 * High-level injectable wrapper over PrismaTransactionService that guarantees
 * atomic execution and rollback across multi-step ledger, budget, and audit writes.
 */
@Injectable()
export class DatabaseTransactionService {
  constructor(private readonly prismaTx: PrismaTransactionService) {}

  async executeInTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    return this.prismaTx.run(operation, options);
  }
}
