import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Body,
  CanActivate,
  Controller,
  Get,
  INestApplication,
  Injectable,
  Logger,
  NotFoundException,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { ZodValidationExceptionFilter } from './zod-validation-exception.filter';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { ValidationIssueCode } from '../validators/zod-error';

const createOrderSchema = z.object({
  symbol: z.string().min(2),
  quantity: z.number().positive(),
  options: z.object({
    timeInForce: z.enum(['IOC', 'GTC']),
  }),
});

const listOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['PENDING', 'COMPLETED', 'CANCELLED']).optional(),
});

@Injectable()
class RejectingAuthGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException('Authentication credentials missing or invalid');
  }
}

@Controller('orders')
class OrdersTestController {
  @Post()
  create(@Body(new ZodValidationPipe(createOrderSchema)) body: z.infer<typeof createOrderSchema>) {
    return { ok: true, data: body };
  }

  @Get()
  list(@Query(new ZodValidationPipe(listOrdersQuerySchema)) query: z.infer<typeof listOrdersQuerySchema>) {
    return { ok: true, data: query };
  }

  @Get('secure')
  @UseGuards(RejectingAuthGuard)
  secure() {
    return { ok: true };
  }

  @Get(':id')
  getById() {
    throw new NotFoundException('Order not found');
  }
}

describe('Zod validation error envelope (Integration)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      controllers: [OrdersTestController],
      providers: [{ provide: APP_FILTER, useClass: ZodValidationExceptionFilter }],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/api/v1`;
  });

  afterAll(async () => {
    await app.close();
  });

  async function call(path: string, init: RequestInit = {}) {
    const res = await fetch(`${baseUrl}${path}`, init);
    const body = (await res.json()) as {
      success: boolean;
      error: { code: string; message: string; errors?: Array<{ path: string; message: string; code: string }> };
      meta: { requestId: string };
    };
    return { res, body };
  }

  it('returns uniform envelope for invalid request body (400)', async () => {
    const { res, body } = await call('/orders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req_order_validation_fail',
      },
      body: JSON.stringify({
        symbol: 'A',
        quantity: -10,
        options: { timeInForce: 'INVALID_TIF' },
      }),
    });

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.meta).toBeDefined();
    expect(body.meta.requestId).toBe('req_order_validation_fail');
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Request validation failed');

    expect(body.error.errors).toContainEqual({
      path: 'symbol',
      message: 'String must contain at least 2 character(s)',
      code: ValidationIssueCode.TOO_SMALL,
    });
    expect(body.error.errors).toContainEqual({
      path: 'quantity',
      message: 'Number must be greater than 0',
      code: ValidationIssueCode.TOO_SMALL,
    });
    expect(body.error.errors).toContainEqual({
      path: 'options.timeInForce',
      message: "Invalid enum value. Expected 'IOC' | 'GTC', received 'INVALID_TIF'",
      code: ValidationIssueCode.INVALID_ENUM,
    });
  });

  it('returns uniform envelope for missing fields in body (400)', async () => {
    const { res, body } = await call('/orders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.meta.requestId).toBeDefined();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'symbol', code: ValidationIssueCode.REQUIRED }),
        expect.objectContaining({ path: 'quantity', code: ValidationIssueCode.REQUIRED }),
        expect.objectContaining({ path: 'options', code: ValidationIssueCode.REQUIRED }),
      ]),
    );
  });

  it('handles missing request body cleanly (400)', async () => {
    const { res, body } = await call('/orders', {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.meta.requestId).toBeDefined();
  });

  it('handles malformed JSON body cleanly (400)', async () => {
    const { res, body } = await call('/orders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{"symbol": "BTC", invalid json',
    });

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.meta.requestId).toBeDefined();
    expect(body.error.message).toContain('Malformed JSON');
  });

  it('returns uniform envelope for invalid query parameters (400)', async () => {
    const { res, body } = await call('/orders?page=0&limit=500&status=UNKNOWN', {
      method: 'GET',
      headers: {
        'x-request-id': 'req_query_validation_fail',
      },
    });

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.meta.requestId).toBe('req_query_validation_fail');
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.errors).toContainEqual(
      expect.objectContaining({ path: 'page', code: ValidationIssueCode.TOO_SMALL }),
    );
    expect(body.error.errors).toContainEqual(
      expect.objectContaining({ path: 'limit', code: ValidationIssueCode.TOO_BIG }),
    );
    expect(body.error.errors).toContainEqual(
      expect.objectContaining({ path: 'status', code: ValidationIssueCode.INVALID_ENUM }),
    );
  });

  it('passes non-validation authentication error through the envelope (401)', async () => {
    const { res, body } = await call('/orders/secure');

    expect(res.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toBe('Authentication credentials missing or invalid');
    expect(body.meta.requestId).toBeDefined();
  });

  it('passes non-validation not-found error through the envelope (404)', async () => {
    const { res, body } = await call('/orders/9999');

    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('Order not found');
    expect(body.meta.requestId).toBeDefined();
  });
});
