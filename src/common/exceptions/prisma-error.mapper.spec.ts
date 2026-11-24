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
  it('maps P2002 to 409 CONFLICT and names the conflicting fields', () => {
    const mapped = mapPrismaError(known('P2002', 'Unique constraint failed on the fields: (`email`)', { target: ['email'] }));

    expect(mapped).toBeInstanceOf(PrismaMappedError);
    expect(mapped).toMatchObject({
      code: ErrorCode.CONFLICT,
      status: 409,
      prismaCode: 'P2002',
      fields: ['email'],
      message: 'A resource with this email already exists',
    });
  });

  it('joins compound unique targets', () => {
    const mapped = mapPrismaError(known('P2002', 'x', { target: ['organizationId', 'slug'] }));
    expect(mapped?.fields).toEqual(['organizationId', 'slug']);
    expect(mapped?.message).toBe('A resource with this organizationId, slug already exists');
  });

  it('does not expose a database constraint name when P2002 target is a string', () => {
    const mapped = mapPrismaError(known('P2002', 'x', { target: 'users_email_key' }));
    expect(mapped?.fields).toBeUndefined();
    expect(mapped?.message).toBe('A resource with these unique attributes already exists');
    expect(mapped?.message).not.toContain('users_email_key');
  });

  it('maps P2025 to 404 NOT_FOUND', () => {
    expect(mapPrismaError(known('P2025'))).toMatchObject({ code: ErrorCode.NOT_FOUND, status: 404, prismaCode: 'P2025' });
  });

  it('maps P2003 to 400 BAD_REQUEST', () => {
    expect(mapPrismaError(known('P2003'))).toMatchObject({ code: ErrorCode.BAD_REQUEST, status: 400, prismaCode: 'P2003' });
  });

  it('maps P2000 to 422 VALIDATION_ERROR', () => {
    expect(mapPrismaError(known('P2000'))).toMatchObject({ code: ErrorCode.VALIDATION_ERROR, status: 422 });
  });

  it('maps PrismaClientValidationError to 400 BAD_REQUEST', () => {
    const error = new Prisma.PrismaClientValidationError('Argument `amount` is missing', { clientVersion: CLIENT_VERSION });
    expect(mapPrismaError(error)).toMatchObject({ code: ErrorCode.BAD_REQUEST, status: 400, prismaCode: undefined });
  });

  it('maps an unmapped known code to a generic 500', () => {
    const mapped = mapPrismaError(known('P2010', 'Raw query failed: SELECT * FROM secret_table'));
    expect(mapped).toMatchObject({ code: ErrorCode.INTERNAL_ERROR, status: 500, prismaCode: 'P2010' });
    expect(mapped?.message).not.toContain('secret_table');
  });

  it('maps non-request Prisma errors to a generic 500', () => {
    const error = new Prisma.PrismaClientInitializationError('Can not reach database at db:5432', CLIENT_VERSION);
    const mapped = mapPrismaError(error);
    expect(mapped).toMatchObject({ code: ErrorCode.INTERNAL_ERROR, status: 500 });
    expect(mapped?.message).not.toContain('db:5432');
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
    expect(mapPrismaError(known('P2010'))!.permanent).toBe(false);
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
