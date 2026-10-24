import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INestApplication, Logger, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { NextFunction, Request, Response } from 'express';

import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { AgentThrottlerGuard } from '../../common/guards/agent-throttler.guard';
import { AstroidThrottlerGuard } from '../../common/guards/throttler.guard';

/**
 * Controller-level validation of the wallet endpoints.
 *
 * The tests drive the real controller over HTTP so an invalid payload is
 * rejected by the Zod pipe *before* any wallet business logic runs.
 */

const VALID_ADDRESS = 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5';
const VALID_UUID = '018f0a1b-7c3d-7a1e-9f2b-1c2d3e4f5a6b';

@Module({})
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((request: Request, _response: Response, next: NextFunction) => {
        // The JWT strategy normally populates the principal.
        (request as Request & { user?: unknown }).user = {
          id: 'user-1',
          organizationId: 'org-1',
          email: 'owner@example.com',
          role: 'OWNER',
        };
        next();
      })
      .forRoutes('*');
  }
}

describe('WalletController — request validation', () => {
  let app: INestApplication;
  let baseUrl: string;
  let walletService: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    walletService = {
      create: vi.fn().mockResolvedValue({ id: 'wallet-1' }),
      update: vi.fn().mockResolvedValue({ id: 'wallet-1' }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
      controllers: [WalletController],
      providers: [
        { provide: WalletService, useValue: walletService },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    })
      // The rate-limiters are irrelevant for a validation test and would pull
      // in the whole throttler configuration.
      .overrideGuard(AgentThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AstroidThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/api/v1`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    walletService.create.mockClear();
    walletService.update.mockClear();
  });

  async function post(path: string, body: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { res, body: (await res.json()) as Record<string, unknown> };
  }

  async function patch(path: string, body: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { res, body: (await res.json()) as Record<string, unknown> };
  }

  describe('POST /wallets', () => {
    it('accepts a valid generated wallet', async () => {
      const { res } = await post('/wallets', { label: 'Operations' });

      expect(res.status).toBe(201);
      expect(walletService.create).toHaveBeenCalledTimes(1);
    });

    it('accepts a valid imported wallet', async () => {
      const { res } = await post('/wallets', { stellarAddress: VALID_ADDRESS });

      expect(res.status).toBe(201);
      expect(walletService.create).toHaveBeenCalledWith(
        'org-1',
        'user-1',
        expect.objectContaining({ stellarAddress: VALID_ADDRESS }),
      );
    });

    it('rejects a malformed Stellar address before the service runs', async () => {
      const { res, body } = await post('/wallets', { stellarAddress: 'not-an-address' });

      expect(res.status).toBe(400);
      expect(body).toMatchObject({
        type: 'urn:astroid:problem:validation-error',
        title: 'Validation Failed',
        status: 400,
        code: 'VALIDATION_ERROR',
      });
      expect((body.details as Array<{ path: string }>).map((detail) => detail.path)).toContain(
        'stellarAddress',
      );
      expect(walletService.create).not.toHaveBeenCalled();
    });

    it('rejects a Stellar contract id before the service runs', async () => {
      const { res } = await post('/wallets', {
        stellarAddress: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      });

      expect(res.status).toBe(400);
      expect(walletService.create).not.toHaveBeenCalled();
    });

    it('rejects an empty label before the service runs', async () => {
      const { res, body } = await post('/wallets', { label: '   ' });

      expect(res.status).toBe(400);
      expect((body.details as Array<{ message: string }>)[0].message).toBe(
        'Label must not be empty',
      );
      expect(walletService.create).not.toHaveBeenCalled();
    });

    it('rejects a malformed agent id before the service runs', async () => {
      const { res } = await post('/wallets', { agentId: 'agent-1' });

      expect(res.status).toBe(400);
      expect(walletService.create).not.toHaveBeenCalled();
    });

    it('rejects an unexpected property before the service runs', async () => {
      const { res } = await post('/wallets', { secretKey: 'SABC' });

      expect(res.status).toBe(400);
      expect(walletService.create).not.toHaveBeenCalled();
    });

    it('rejects a wrong property type before the service runs', async () => {
      const { res } = await post('/wallets', { label: 42 });

      expect(res.status).toBe(400);
      expect(walletService.create).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /wallets/:id', () => {
    it('accepts a valid update', async () => {
      const { res } = await patch(`/wallets/${VALID_UUID}`, { label: 'Renamed' });

      expect(res.status).toBe(200);
      expect(walletService.update).toHaveBeenCalledTimes(1);
    });

    it('rejects an empty update body before the service runs', async () => {
      const { res, body } = await patch(`/wallets/${VALID_UUID}`, {});

      expect(res.status).toBe(400);
      expect((body.details as Array<{ message: string }>)[0].message).toBe(
        'Provide at least one field to update',
      );
      expect(walletService.update).not.toHaveBeenCalled();
    });

    it('rejects a malformed agent id before the service runs', async () => {
      const { res } = await patch(`/wallets/${VALID_UUID}`, { agentId: 'agent-1' });

      expect(res.status).toBe(400);
      expect(walletService.update).not.toHaveBeenCalled();
    });

    it('rejects an unexpected property before the service runs', async () => {
      const { res } = await patch(`/wallets/${VALID_UUID}`, { status: 'FROZEN' });

      expect(res.status).toBe(400);
      expect(walletService.update).not.toHaveBeenCalled();
    });
  });
});
