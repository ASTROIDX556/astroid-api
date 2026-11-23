import { CanActivate, ExecutionContext, INestApplication, Injectable } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodValidationExceptionFilter } from '../../common/filters/zod-validation-exception.filter';
import { ValidationIssueCode } from '../../common/validators/zod-error';
import { AuditArchiveService } from './audit-archive.service';
import { encodeAuditCursor } from './audit-cursor';
import { AUDIT_DEFAULT_PAGE_SIZE, AUDIT_MAX_PAGE_SIZE } from './audit-list.dto';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/** Stands in for the JWT guard: attaches an authenticated principal to every request. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: unknown }>();
    request.user = { id: 'user-1', organizationId: 'org-1', role: 'OWNER' };
    return true;
  }
}

/**
 * GET /audit over real HTTP: the query is validated by the Zod pipe in front of
 * the controller, and the parsed query is handed to the service together with
 * the caller's organization (never one taken from the query string).
 */
describe('GET /audit over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;
  const auditService = { list: vi.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_FILTER, useClass: ZodValidationExceptionFilter },
        { provide: AuditService, useValue: auditService },
        { provide: AuditArchiveService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    auditService.list.mockReset().mockResolvedValue({ items: [], meta: { hasNext: false, nextCursor: null } });
  });

  const get = (query: string) => fetch(`${baseUrl}/audit${query}`);

  it('answers the first page with the configured default page size and no filters', async () => {
    const res = await get('');

    expect(res.status).toBe(200);
    expect(auditService.list).toHaveBeenCalledTimes(1);
    const [organizationId, query] = auditService.list.mock.calls[0];
    expect(organizationId).toBe('org-1');
    expect(query).toMatchObject({ limit: AUDIT_DEFAULT_PAGE_SIZE, page: 1, offset: 0 });
    expect(query).not.toHaveProperty('resourceType');
    expect(query).not.toHaveProperty('cursor');
  });

  it("hands every parsed filter to the service for the caller's organization", async () => {
    const cursor = encodeAuditCursor({ createdAt: new Date('2026-09-29T12:00:00.000Z'), id: 'audit-1' });

    const res = await get(
      `?limit=50&cursor=${cursor}&actorId=user-2&action=transaction.created&resourceType=Transaction` +
        '&resourceId=txn-9&from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z',
    );

    expect(res.status).toBe(200);
    expect(auditService.list).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        limit: 50,
        cursor,
        actorId: 'user-2',
        action: 'transaction.created',
        resourceType: 'Transaction',
        resourceId: 'txn-9',
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T00:00:00.000Z',
      }),
    );
  });

  it('filters by resource type alone', async () => {
    const res = await get('?resourceType=Wallet');

    expect(res.status).toBe(200);
    expect(auditService.list).toHaveBeenCalledWith('org-1', expect.objectContaining({ resourceType: 'Wallet' }));
  });

  it('never takes the organization from the query string', async () => {
    const res = await get('?organizationId=org-2');

    expect(res.status).toBe(400);
    expect(auditService.list).not.toHaveBeenCalled();
  });

  it('accepts the page size cap and a range whose ends are equal (boundaries)', async () => {
    const same = '2026-09-15T00:00:00.000Z';
    const res = await get(`?limit=${AUDIT_MAX_PAGE_SIZE}&from=${same}&to=${same}`);

    expect(res.status).toBe(200);
    expect(auditService.list).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ limit: AUDIT_MAX_PAGE_SIZE, from: same, to: same }),
    );
  });

  it.each([
    ['a limit above the cap', `?limit=${AUDIT_MAX_PAGE_SIZE + 1}`],
    ['a limit of zero', '?limit=0'],
    ['a non-numeric limit', '?limit=many'],
    ['a malformed cursor', '?cursor=not-a-cursor'],
    ['an unknown parameter', '?foo=bar'],
    ['a date that is not ISO-8601', '?from=yesterday'],
    ['a range that ends before it starts', '?from=2026-09-30T00:00:00.000Z&to=2026-09-01T00:00:00.000Z'],
    ['an empty resource type', '?resourceType='],
    ['a resource type that is too long', `?resourceType=${'x'.repeat(121)}`],
    ['both offset and page', '?offset=20&page=2'],
    ['both pageSize and limit', '?pageSize=10&limit=10'],
  ])('answers 400 for %s without calling the service', async (_label, query) => {
    const res = await get(query);

    expect(res.status).toBe(400);
    expect(auditService.list).not.toHaveBeenCalled();
  });

  type ErrorEnvelope = {
    success: boolean;
    error: { code: string; message: string; errors: Array<{ path: string; message: string; code: string }> };
    meta: { requestId: string };
  };

  it.each([
    ['actorId', '?actorId=user-1'],
    ['action', '?action=wallet.created'],
    ['resourceId', '?resourceId=wallet-1'],
    ['from', '?from=2026-09-01T00:00:00.000Z'],
    ['to', '?to=2026-09-30T00:00:00%2B02:00'],
  ])('accepts the %s filter on its own', async (name, query) => {
    const res = await get(query);

    expect(res.status).toBe(200);
    expect(auditService.list.mock.calls[0][1]).toHaveProperty(name);
  });

  it('rejects from > to with 400 and the standard validation envelope', async () => {
    const res = await get('?from=2026-09-30T00:00:00.000Z&to=2026-09-01T00:00:00.000Z');
    const body = (await res.json()) as ErrorEnvelope;

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.meta.requestId).toEqual(expect.any(String));
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.errors).toContainEqual({
      path: 'to',
      message: '`to` must be greater than or equal to `from`',
      code: ValidationIssueCode.CUSTOM,
    });
    expect(auditService.list).not.toHaveBeenCalled();
  });

  it('rejects an unknown parameter with 400 and the standard validation envelope', async () => {
    const res = await get('?actor=user-1');
    const body = (await res.json()) as ErrorEnvelope;

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: ValidationIssueCode.UNRECOGNIZED_KEYS })]),
    );
  });

  it('rejects a timestamp that is not ISO 8601 with 400 and the standard validation envelope', async () => {
    const res = await get('?to=2026-09-30');
    const body = (await res.json()) as ErrorEnvelope;

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'to' })]));
  });
});
