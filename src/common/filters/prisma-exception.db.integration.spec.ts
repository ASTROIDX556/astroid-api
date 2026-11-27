import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Body, Controller, INestApplication, Param, Post } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { PrismaClient, UserRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { EventBusService } from '../../events/event-bus.service';
import { OrganizationRepository } from '../../modules/organizations/organization.repository';
import { OrganizationService } from '../../modules/organizations/organization.service';
import { ErrorCode } from '../constants/error-codes';
import { GlobalExceptionFilter } from './global-exception.filter';
import { ZodValidationExceptionFilter } from './zod-validation-exception.filter';
import { PrismaExceptionFilter } from './prisma-exception.filter';

/**
 * A real duplicate insert against PostgreSQL, through the real organization
 * service and repository, rendered by the production filter chain. Skipped
 * without DATABASE_URL (CI's build-and-test job provides one).
 *
 * `inviteMember` checks for an existing email and then inserts. Two concurrent
 * invites can both pass the check; the loser's INSERT then violates the
 * unique index on users.email (P2002), which nothing in the service catches.
 * The test makes the losing side deterministic by having the pre-check miss,
 * exactly as it does when the other request commits in between.
 */
const databaseUrl = process.env.DATABASE_URL;
const suffix = randomUUID();
const organizationId = `prisma-filter-org-${suffix}`;
const email = `taken-${suffix}@example.test`;

@Controller('orgs')
class InviteController {
  constructor(private readonly organizations: OrganizationService) {}

  @Post(':organizationId/members')
  invite(@Param('organizationId') id: string, @Body() body: { name: string; email: string }) {
    return this.organizations.inviteMember(id, 'actor-1', { ...body, role: UserRole.VIEWER });
  }
}

describe.skipIf(!databaseUrl)('Duplicate insert through the service layer (real Postgres)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl as string } } });
    await prisma.$connect();
    await prisma.organization.create({
      data: { id: organizationId, name: 'Prisma filter org', slug: `prisma-filter-${suffix}` },
    });
    await prisma.user.create({ data: { organizationId, name: 'Existing', email } });

    // Lose the check-then-insert race: the existence pre-check misses, the
    // INSERT still hits the real unique index.
    const racingPrisma = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === 'user') {
          return { ...target.user, findUnique: vi.fn().mockResolvedValue(null) };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [InviteController],
      providers: [
        OrganizationService,
        OrganizationRepository,
        { provide: PrismaService, useValue: racingPrisma },
        { provide: EventBusService, useValue: { emit: vi.fn().mockResolvedValue(undefined) } },
        // Same filters, same order as app.module.ts.
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
        { provide: APP_FILTER, useClass: ZodValidationExceptionFilter },
        { provide: APP_FILTER, useClass: PrismaExceptionFilter },
      ],
    }).compile();
    // OrganizationRepository must use the real client for the INSERT.
    (moduleRef.get(OrganizationRepository) as unknown as { prisma: PrismaClient }).prisma = prisma;

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  }, 30_000);

  it('answers 409 CONFLICT in the standard envelope, without the constraint or field name', async () => {
    const res = await fetch(`${baseUrl}/orgs/${organizationId}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-real-dup' },
      body: JSON.stringify({ name: 'Duplicate', email }),
    });
    const text = await res.text();

    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(JSON.parse(text)).toMatchObject({
      status: 409,
      code: ErrorCode.CONFLICT,
      detail: 'A resource with these details already exists',
      requestId: 'req-real-dup',
    });
    expect(text).not.toMatch(/users_email_key|email|Unique constraint|P2002/);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  }, 30_000);
});
