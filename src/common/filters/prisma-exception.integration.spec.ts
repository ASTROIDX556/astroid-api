import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  INestApplication,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaExceptionFilter } from './prisma-exception.filter';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { GlobalExceptionFilter } from './global-exception.filter';
import { ZodValidationExceptionFilter } from './zod-validation-exception.filter';
import { ErrorCode } from '../constants/error-codes';
import { ConflictException } from '../exceptions/domain.exception';

@Controller('test-prisma')
class TestPrismaController {
  @Post('unique')
  throwUnique() {
    throw new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`email`)',
      {
        code: 'P2002',
        clientVersion: '5.22.0',
        meta: { target: ['email'] },
      },
    );
  }

  @Get('not-found')
  throwNotFound() {
    throw new Prisma.PrismaClientKnownRequestError('Record to delete does not exist.', {
      code: 'P2025',
      clientVersion: '5.22.0',
    });
  }

  @Post('fk')
  throwFk() {
    throw new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
      code: 'P2003',
      clientVersion: '5.22.0',
    });
  }

  @Post('value-too-long')
  throwValueTooLong() {
    throw new Prisma.PrismaClientKnownRequestError('Value too long', {
      code: 'P2000',
      clientVersion: '5.22.0',
    });
  }

  @Get('malformed-uuid')
  throwMalformedUuid() {
    throw new Prisma.PrismaClientKnownRequestError(
      'Inconsistent column data: Error creating UUID, invalid character',
      { code: 'P2023', clientVersion: '5.22.0', meta: { modelName: 'Wallet' } },
    );
  }

  @Get('database-down')
  throwDatabaseDown() {
    throw new Prisma.PrismaClientInitializationError(
      "Can't reach database server at `db.internal:5432`",
      '5.22.0',
      'P1001',
    );
  }

  @Get('http-exception')
  throwHttpException() {
    throw new NotFoundException('Nothing here');
  }

  @Get('domain-exception')
  throwDomainException() {
    throw new ConflictException('Agent name is already taken');
  }

  @Post('unknown')
  throwUnknown() {
    throw new Prisma.PrismaClientKnownRequestError('SELECT * FROM secret_table crashed', {
      code: 'P9999',
      clientVersion: '5.22.0',
    });
  }
}

describe('PrismaExceptionFilter Integration', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TestPrismaController],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_FILTER, useClass: PrismaExceptionFilter },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    await app.listen(0);
    const server = app.getHttpServer();
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('maps unique constraint violation to 409 CONFLICT with requestId and safe detail', async () => {
    const res = await fetch(`${baseUrl}/test-prisma/unique`, {
      method: 'POST',
      headers: { 'x-request-id': 'req-test-unique-123' },
    });

    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('application/problem+json');

    const body = await res.json();
    expect(body).toMatchObject({
      status: 409,
      code: ErrorCode.CONFLICT,
      detail: 'A resource with these details already exists',
      requestId: 'req-test-unique-123',
    });
    expect(body.detail).not.toContain('Prisma');
    expect(JSON.stringify(body)).not.toContain('email');
  });

  it('maps record not found to 404 NOT_FOUND', async () => {
    const res = await fetch(`${baseUrl}/test-prisma/not-found`, {
      method: 'GET',
      headers: { 'x-request-id': 'req-test-nf-456' },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 404,
      code: ErrorCode.NOT_FOUND,
      detail: 'Resource not found',
      requestId: 'req-test-nf-456',
    });
  });

  it('maps foreign key constraint failure to 409 CONFLICT without leaking internals', async () => {
    const res = await fetch(`${baseUrl}/test-prisma/fk`, {
      method: 'POST',
      headers: { 'x-request-id': 'req-fk-1' },
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 409,
      code: ErrorCode.CONFLICT,
      requestId: 'req-fk-1',
    });
    expect(body).not.toHaveProperty('stack');
    // The raw Prisma message must not reach the client, nor any stack frame.
    expect(body.detail).not.toBe('Foreign key constraint failed');
    expect(JSON.stringify(body)).not.toMatch(/PrismaClient|\n\s+at |\.ts:\d+/);
  });

  it('maps value too long to 400 BAD_REQUEST', async () => {
    const res = await fetch(`${baseUrl}/test-prisma/value-too-long`, {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 400,
      code: ErrorCode.BAD_REQUEST,
    });
  });

  it('maps unknown database errors to 500 without leaking SQL or internals', async () => {
    const res = await fetch(`${baseUrl}/test-prisma/unknown`, {
      method: 'POST',
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 500,
      code: ErrorCode.INTERNAL_ERROR,
      detail: 'An unexpected database error occurred',
    });
    expect(body.detail).not.toContain('secret_table');
    expect(body.detail).not.toContain('SELECT');
  });
});

/**
 * The same three global filters, in the same order, as app.module.ts — the
 * chain that actually renders errors in the running API.
 */
describe('Prisma errors through the production filter chain', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TestPrismaController],
      providers: [
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
        { provide: APP_FILTER, useClass: ZodValidationExceptionFilter },
        { provide: APP_FILTER, useClass: PrismaExceptionFilter },
      ],
    }).compile();

    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = async (method: 'GET' | 'POST', path: string, requestId: string) => {
    const res = await fetch(`${baseUrl}/test-prisma/${path}`, { method, headers: { 'x-request-id': requestId } });
    return { res, text: await res.text() };
  };

  it.each([
    ['POST', 'unique', 409, ErrorCode.CONFLICT, 'A resource with these details already exists'],
    ['GET', 'not-found', 404, ErrorCode.NOT_FOUND, 'Resource not found'],
    ['POST', 'fk', 409, ErrorCode.CONFLICT, 'The operation conflicts with a related resource that does not exist or is still in use'],
    ['POST', 'value-too-long', 400, ErrorCode.BAD_REQUEST, 'A provided value is too long'],
    ['GET', 'malformed-uuid', 400, ErrorCode.BAD_REQUEST, 'A provided value has an invalid format'],
    ['GET', 'database-down', 503, ErrorCode.DATABASE_UNAVAILABLE, 'The database is temporarily unavailable; please retry later'],
    ['POST', 'unknown', 500, ErrorCode.INTERNAL_ERROR, 'An unexpected database error occurred'],
  ] as const)('%s /%s -> %i %s in the problem-details envelope with the requestId', async (method, path, status, code, detail) => {
    const { res, text } = await call(method, path, `req-${path}`);

    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(JSON.parse(text)).toMatchObject({ status, code, detail, requestId: `req-${path}`, instance: `/test-prisma/${path}` });
    expect(text).not.toMatch(/email|Wallet|UUID|db\.internal|secret_table|SELECT|PrismaClient|P\d{4}|\n\s+at /);
  });

  it('leaves HttpException handling unchanged', async () => {
    const { res, text } = await call('GET', 'http-exception', 'req-http');

    expect(res.status).toBe(404);
    expect(JSON.parse(text)).toEqual({
      success: false,
      error: { code: ErrorCode.NOT_FOUND, message: 'Nothing here' },
      meta: { requestId: 'req-http' },
    });
  });

  it('leaves domain exception handling unchanged', async () => {
    const { res, text } = await call('GET', 'domain-exception', 'req-domain');

    expect(res.status).toBe(409);
    expect(JSON.parse(text)).toEqual({
      success: false,
      error: { code: ErrorCode.CONFLICT, message: 'Agent name is already taken' },
      meta: { requestId: 'req-domain' },
    });
  });
});
