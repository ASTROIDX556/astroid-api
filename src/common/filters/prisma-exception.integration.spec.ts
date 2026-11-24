import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  INestApplication,
  Post,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaExceptionFilter } from './prisma-exception.filter';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ErrorCode } from '../constants/error-codes';

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
      detail: 'A resource with this email already exists',
      requestId: 'req-test-unique-123',
    });
    expect(body.detail).not.toContain('Prisma');
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

  it('maps foreign key constraint failure to 400 BAD_REQUEST without leaking internals', async () => {
    const res = await fetch(`${baseUrl}/test-prisma/fk`, {
      method: 'POST',
      headers: { 'x-request-id': 'req-fk-1' },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 400,
      code: ErrorCode.BAD_REQUEST,
      requestId: 'req-fk-1',
    });
    expect(body).not.toHaveProperty('stack');
    // The raw Prisma message must not reach the client, nor any stack frame.
    expect(body.detail).not.toBe('Foreign key constraint failed');
    expect(JSON.stringify(body)).not.toMatch(/PrismaClient|\n\s+at |\.ts:\d+/);
  });

  it('maps value too long to 422 VALIDATION_ERROR', async () => {
    const res = await fetch(`${baseUrl}/test-prisma/value-too-long`, {
      method: 'POST',
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 422,
      code: ErrorCode.VALIDATION_ERROR,
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
