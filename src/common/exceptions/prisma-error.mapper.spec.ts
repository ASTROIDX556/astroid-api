import { describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCode } from '../constants/error-codes';
import { isPrismaClientError, mapPrismaError, PrismaMappedError } from './prisma-error.mapper';
import { classifyJobError } from '../../queues/queue-policy';

const CLIENT_VERSION = '5.22.0';

function known(code: string, message = 'raw prisma message', meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: CLIENT_VERSION, meta });
}

describe('mapPrismaError', () => {
  it('maps P2002 to 409 CONFLICT with a generic message (fields kept for logs only)', () => {
    const mapped = mapPrismaError(known('P2002', 'Unique constraint failed on the fields: (`email`)', { target: ['email'] }));

    expect(mapped).toBeInstanceOf(PrismaMappedError);
    expect(mapped).toMatchObject({
      code: ErrorCode.CONFLICT,
      status: 409,
      prismaCode: 'P2002',
      fields: ['email'],
      message: 'A resource with these details already exists',
    });
    expect(mapped?.message).not.toContain('email');
  });

  it('keeps compound unique targets for logs without naming them to the client', () => {
    const mapped = mapPrismaError(known('P2002', 'x', { target: ['organizationId', 'slug'] }));
    expect(mapped?.fields).toEqual(['organizationId', 'slug']);
    expect(mapped?.message).toBe('A resource with these details already exists');
  });

  it('ignores a database constraint name when P2002 target is a string', () => {
    const mapped = mapPrismaError(known('P2002', 'x', { target: 'users_email_key' }));
    expect(mapped?.fields).toBeUndefined();
    expect(mapped?.message).toBe('A resource with these details already exists');
    expect(mapped?.message).not.toContain('users_email_key');
  });

  it('maps P2025 to 404 NOT_FOUND', () => {
    expect(mapPrismaError(known('P2025'))).toMatchObject({
      code: ErrorCode.NOT_FOUND,
      status: 404,
      prismaCode: 'P2025',
      message: 'Resource not found',
    });
  });

  it('maps P2003 to 409 CONFLICT', () => {
    expect(mapPrismaError(known('P2003', 'x', { field_name: 'wallets_organizationId_fkey (index)' }))).toMatchObject({
      code: ErrorCode.CONFLICT,
      status: 409,
      prismaCode: 'P2003',
      message: 'The operation conflicts with a related resource that does not exist or is still in use',
    });
  });

  it('maps P2000 to 400 BAD_REQUEST', () => {
    expect(mapPrismaError(known('P2000', 'x', { column_name: 'memo' }))).toMatchObject({
      code: ErrorCode.BAD_REQUEST,
      status: 400,
      prismaCode: 'P2000',
      message: 'A provided value is too long',
    });
  });

  it('maps P2023 (e.g. a malformed UUID) to 400 BAD_REQUEST', () => {
    expect(
      mapPrismaError(known('P2023', 'Inconsistent column data: Error creating UUID, invalid character', { message: 'Error creating UUID' })),
    ).toMatchObject({
      code: ErrorCode.BAD_REQUEST,
      status: 400,
      prismaCode: 'P2023',
      message: 'A provided value has an invalid format',
    });
  });

  it('maps PrismaClientValidationError to 400 BAD_REQUEST', () => {
    const error = new Prisma.PrismaClientValidationError('Argument `amount` is missing', { clientVersion: CLIENT_VERSION });
    expect(mapPrismaError(error)).toMatchObject({ code: ErrorCode.BAD_REQUEST, status: 400, prismaCode: undefined });
  });

  it('maps an unmapped known code to a generic 500', () => {
    const mapped = mapPrismaError(known('P2010', 'Raw query failed: SELECT * FROM secret_table'));
    expect(mapped).toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
      status: 500,
      prismaCode: 'P2010',
      message: 'An unexpected database error occurred',
    });
    expect(mapped?.message).not.toContain('secret_table');
  });

  it('maps an initialisation (connection) error to 503 DATABASE_UNAVAILABLE', () => {
    const error = new Prisma.PrismaClientInitializationError("Can't reach database server at `db:5432`", CLIENT_VERSION, 'P1001');
    const mapped = mapPrismaError(error);
    expect(mapped).toMatchObject({
      code: ErrorCode.DATABASE_UNAVAILABLE,
      status: 503,
      prismaCode: 'P1001',
      message: 'The database is temporarily unavailable; please retry later',
    });
    expect(mapped?.message).not.toContain('db:5432');
  });

  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024'])(
    'maps the connection-level known request code %s (database lost after start-up) to 503 DATABASE_UNAVAILABLE',
    (code) => {
      const mapped = mapPrismaError(known(code, "Can't reach database server at `db.internal:5432`"));
      expect(mapped).toMatchObject({
        code: ErrorCode.DATABASE_UNAVAILABLE,
        status: 503,
        prismaCode: code,
        message: 'The database is temporarily unavailable; please retry later',
      });
      expect(mapped?.message).not.toContain('db.internal');
      expect(mapped?.permanent).toBe(false);
    },
  );

  it('maps a Rust engine panic to 503 DATABASE_UNAVAILABLE', () => {
    const error = new Prisma.PrismaClientRustPanicError('PANIC: called `Option::unwrap()` on a `None` value in query-engine/src/lib.rs', CLIENT_VERSION);
    const mapped = mapPrismaError(error);
    expect(mapped).toMatchObject({ code: ErrorCode.DATABASE_UNAVAILABLE, status: 503 });
    expect(mapped?.message).not.toContain('PANIC');
  });

  it('maps an unknown request error to a generic 500', () => {
    const error = new Prisma.PrismaClientUnknownRequestError('engine said something odd', { clientVersion: CLIENT_VERSION });
    expect(mapPrismaError(error)).toMatchObject({ code: ErrorCode.INTERNAL_ERROR, status: 500 });
  });

  it.each([
    ['P2002', { target: ['email'] }, 'Unique constraint failed on the constraint: `users_email_key`'],
    ['P2003', { field_name: 'wallets_organizationId_fkey (index)' }, 'Foreign key constraint failed on the field: `wallets_organizationId_fkey (index)`'],
    ['P2000', { column_name: 'memo' }, "The provided value for the column is too long for the column's type. Column: memo"],
    ['P2023', { message: 'Error creating UUID, invalid character' }, 'Inconsistent column data: Error creating UUID'],
    ['P2025', { cause: 'Record to update not found.', modelName: 'Wallet' }, 'An operation failed because it depends on one or more records that were required but not found. Record to update not found.'],
  ])('never echoes the Prisma message or meta of %s to the client', (code, meta, message) => {
    const mapped = mapPrismaError(known(code, message, meta))!;
    expect(mapped.message).not.toContain(message);
    for (const value of Object.values(meta).flat()) {
      expect(mapped.message).not.toContain(String(value));
    }
    for (const internal of ['users_email_key', 'wallets_organizationId_fkey', 'memo', 'UUID', 'Wallet']) {
      expect(mapped.message).not.toContain(internal);
    }
  });

  it('passes through anything that is not a Prisma error', () => {
    expect(mapPrismaError(new Error('boom'))).toBeUndefined();
    expect(mapPrismaError(new HttpException('nope', 400))).toBeUndefined();
    expect(mapPrismaError('string')).toBeUndefined();
    expect(mapPrismaError(undefined)).toBeUndefined();
    expect(isPrismaClientError(new Error('boom'))).toBe(false);
  });

  it('never carries the raw Prisma message, but keeps the original as cause', () => {
    const original = known('P2002', 'Unique constraint failed on INSERT INTO "users" ("email") VALUES (\'a@b.c\')', { target: ['email'] });
    const mapped = mapPrismaError(original)!;
    expect(mapped.message).not.toContain('INSERT');
    expect(mapped.message).not.toContain('a@b.c');
    expect(mapped.cause).toBe(original);
  });

  it('is usable without HTTP types and produces a secret-free log context', () => {
    const mapped = mapPrismaError(known('P2002', 'x', { target: ['email'] }))!;
    expect(mapped).not.toBeInstanceOf(HttpException);
    expect(mapped.toLogContext()).toEqual({ code: ErrorCode.CONFLICT, status: 409, prismaCode: 'P2002', fields: ['email'] });
  });

  it('marks client-side failures permanent and server faults retryable', () => {
    expect(mapPrismaError(known('P2002'))!.permanent).toBe(true);
    expect(mapPrismaError(known('P2003'))!.permanent).toBe(true);
    expect(mapPrismaError(known('P2023'))!.permanent).toBe(true);
    expect(mapPrismaError(known('P2010'))!.permanent).toBe(false);
    expect(mapPrismaError(new Prisma.PrismaClientInitializationError('down', CLIENT_VERSION))!.permanent).toBe(false);
  });
});

describe('classifyJobError with Prisma errors', () => {
  it('fails deterministic database errors permanently', () => {
    expect(classifyJobError(known('P2002'))).toBe('permanent');
    expect(classifyJobError(known('P2025'))).toBe('permanent');
    expect(classifyJobError(known('P2003'))).toBe('permanent');
  });

  it('retries transient or unknown database errors', () => {
    expect(classifyJobError(known('P2034'))).toBe('retryable');
    expect(classifyJobError(new Prisma.PrismaClientInitializationError('down', CLIENT_VERSION))).toBe('retryable');
  });
});
