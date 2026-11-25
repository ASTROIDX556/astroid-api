import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INestApplication, Logger } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { SlidingWindowThrottlerGuard } from '../../common/guards/sliding-window-throttler.guard';
import { AgentRateLimiterGuard } from './guards/agent-rate-limiter.guard';
import { ConflictException } from '../../common/exceptions/domain.exception';
import { ErrorCode } from '../../common/constants/error-codes';

/**
 * Verifies over real HTTP that the agent identity endpoints validate their
 * payloads with the shared Zod pipe and answer with the standardized RFC 9457
 * error envelope.
 */
const ORGANIZATION_ID = '018f0000-0000-7000-8000-000000000001';
const USER_ID = '018f0000-0000-7000-8000-000000000002';

describe('AgentController (Zod validation)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let agentService: { create: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    agentService = {
      create: vi.fn().mockImplementation(async (_org: string, _actor: string, body: unknown) => ({
        id: '018f0000-0000-7000-8000-000000000003',
        organizationId: ORGANIZATION_ID,
        name: (body as { name: string }).name,
        capabilities: [],
        metadata: {},
        role: 'CUSTOM',
        status: 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AgentController],
      providers: [
        { provide: AgentService, useValue: agentService },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    })
      .overrideGuard(SlidingWindowThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AgentRateLimiterGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    // The JWT guard is not part of this slice; the principal is injected directly.
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: USER_ID, organizationId: ORGANIZATION_ID, role: 'OWNER' };
      next();
    });
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/api/v1`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    agentService.create.mockClear();
  });

  async function post(payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('accepts a valid payload and forwards the parsed body to the service', async () => {
    const { status } = await post({
      name: 'Procurement Bot',
      capabilities: ['payments'],
    });

    expect(status).toBe(201);
    expect(agentService.create).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      USER_ID,
      expect.objectContaining({ name: 'Procurement Bot', capabilities: ['payments'] }),
    );
  });

  it('answers 400 with the standardized error envelope for a missing name', async () => {
    const { status, body } = await post({ capabilities: ['payments'] });

    expect(status).toBe(400);
    expect(body).toEqual(
      expect.objectContaining({
        status: 400,
        code: ErrorCode.VALIDATION_ERROR,
        title: expect.any(String),
        type: expect.any(String),
        instance: '/api/v1/agents',
        requestId: expect.any(String),
      }),
    );
    expect(body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'name' })]),
    );
    expect(agentService.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed Stellar public key before it reaches the repository', async () => {
    const { status, body } = await post({
      name: 'Bad Key Agent',
      publicKey: 'NOT-A-STELLAR-PUBLIC-KEY',
    });

    expect(status).toBe(400);
    expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'publicKey' })]),
    );
    expect(agentService.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown property because the schema is strict', async () => {
    const { status, body } = await post({
      name: 'Strict Agent',
      unexpected: true,
    });

    expect(status).toBe(400);
    expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(agentService.create).not.toHaveBeenCalled();
  });

  it('rejects duplicated capabilities', async () => {
    const { status, body } = await post({
      name: 'Duplicated Capabilities',
      capabilities: ['payments', 'payments'],
    });

    expect(status).toBe(400);
    expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(agentService.create).not.toHaveBeenCalled();
  });

  it('answers 409 with the standardized envelope for a duplicate agent handle', async () => {
    agentService.create.mockRejectedValueOnce(
      new ConflictException("An agent named 'Procurement Bot' already exists in this organization"),
    );

    const { status, body } = await post({ name: 'Procurement Bot' });

    expect(status).toBe(409);
    expect(body).toEqual(
      expect.objectContaining({
        status: 409,
        code: ErrorCode.CONFLICT,
        detail: expect.stringContaining('already exists'),
      }),
    );
  });
});
