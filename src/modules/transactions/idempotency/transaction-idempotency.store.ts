import { Injectable } from '@nestjs/common';
import { IdempotencyStatus, Prisma, TransactionIdempotencyRecord } from '@prisma/client';

import {
  IdempotencyIdentity,
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyReservationInput,
  IdempotencyStore,
  StoredIdempotentResponse,
} from '../../../common/interceptors/idempotency-store';
import { TransactionRepository } from '../transaction.repository';

/**
 * Prisma-backed {@link IdempotencyStore} for transaction submission.
 *
 * The uniqueness guarantee lives in the database
 * (`@@unique([principalId, route, keyHash])`): a racing request that loses
 * the insert is detected through P2002 and resolved to the winner's record
 * instead of executing a second transaction.
 */
@Injectable()
export class TransactionIdempotencyStore implements IdempotencyStore {
  constructor(private readonly repository: TransactionRepository) {}

  async reserve(input: IdempotencyReservationInput): Promise<IdempotencyReservation> {
    const reservation = await this.repository.reserveIdempotencyKey(input);
    return {
      created: reservation.created,
      record: toRecord(reservation.record),
    };
  }

  async find(identity: IdempotencyIdentity): Promise<IdempotencyRecord | null> {
    const record = await this.repository.findIdempotencyKey(identity);
    if (!record || record.expiresAt.getTime() <= Date.now()) return null;
    return toRecord(record);
  }

  async complete(
    id: string,
    response: StoredIdempotentResponse,
    expiresAt: Date,
  ): Promise<void> {
    await this.repository.completeIdempotencyResponse(
      id,
      { statusCode: response.statusCode, body: serialisable(response.body) },
      expiresAt,
    );
  }

  async release(id: string): Promise<void> {
    await this.repository.releaseIdempotencyKey(id);
  }

  async deleteExpired(now = new Date()): Promise<number> {
    const result = await this.repository.deleteExpiredIdempotencyKeys(now);
    return result.count;
  }
}

/** Normalises the persisted JSON column into the shared record contract. */
function toRecord(record: TransactionIdempotencyRecord): IdempotencyRecord {
  return {
    id: record.id,
    requestHash: record.requestHash,
    status: record.status === IdempotencyStatus.COMPLETED ? 'COMPLETED' : 'PROCESSING',
    response: toStoredResponse(record.response),
    expiresAt: record.expiresAt,
  };
}

function toStoredResponse(value: Prisma.JsonValue | null): StoredIdempotentResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as { statusCode?: unknown; body?: unknown };
  if (typeof candidate.statusCode !== 'number') return null;
  return { statusCode: candidate.statusCode, body: candidate.body ?? null };
}

function serialisable(value: unknown): Prisma.InputJsonValue | null {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(JSON.stringify(value));
    return (parsed ?? null) as Prisma.InputJsonValue | null;
  } catch {
    return null;
  }
}
