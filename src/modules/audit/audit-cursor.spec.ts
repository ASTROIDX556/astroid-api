import { ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ZodValidationException, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { decodeAuditCursor, encodeAuditCursor, isValidAuditCursor } from './audit-cursor';
import {
  AUDIT_DEFAULT_PAGE_SIZE,
  AUDIT_MAX_PAGE_SIZE,
  auditListQuerySchema,
} from './audit-list.dto';
import { auditTimelineQuerySchema } from './audit-timeline.dto';

const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString('base64url');

describe('audit cursor', () => {
  it('round-trips the stable timestamp and ID tuple', () => {
    const cursor = { createdAt: new Date('2026-09-29T12:30:00.000Z'), id: 'audit-123' };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it('keeps the ID as the tie-breaker when timestamps are identical', () => {
    const timestamp = new Date('2026-09-29T12:30:00.000Z');
    const first = decodeAuditCursor(encodeAuditCursor({ createdAt: timestamp, id: 'audit-001' }));
    const second = decodeAuditCursor(encodeAuditCursor({ createdAt: timestamp, id: 'audit-002' }));

    expect(first.createdAt.getTime()).toBe(second.createdAt.getTime());
    expect(first.id).not.toBe(second.id);
    expect(encodeAuditCursor(first)).not.toBe(encodeAuditCursor(second));
  });

  it.each([
    '',
    'not-a-cursor',
    'e30',
    encode({ v: 2, createdAt: '2026-09-29T12:30:00.000Z', id: 'audit-1' }),
    encode({ v: 1, createdAt: 'not-a-date', id: 'audit-1' }),
    encode({ v: 1, createdAt: '2026-09-29T12:30:00.000Z', id: 'bad id!' }),
    encode({ v: 1, createdAt: '2026-09-29T12:30:00.000Z' }),
    encode(['2026-09-29T12:30:00.000Z', 'audit-1']),
  ])('rejects malformed cursor %s', (cursor) => {
    expect(isValidAuditCursor(cursor)).toBe(false);
    expect(auditListQuerySchema.safeParse({ cursor }).success).toBe(false);
    expect(auditTimelineQuerySchema.safeParse({ cursor }).success).toBe(false);
    expect(() => decodeAuditCursor(cursor)).toThrow(ZodValidationException);
  });

  it('maps a malformed cursor to a 400 validation error in the standard envelope', () => {
    const pipe = new ZodValidationPipe(auditListQuerySchema);
    const metadata = { type: 'query' } as ArgumentMetadata;

    try {
      pipe.transform({ cursor: 'bad-cursor' }, metadata);
      expect.unreachable('the pipe should reject the cursor');
    } catch (error) {
      expect(error).toBeInstanceOf(ZodValidationException);
      expect((error as ZodValidationException).getStatus()).toBe(400);
      expect((error as ZodValidationException).code).toBe('VALIDATION_ERROR');
    }
  });

  it('accepts a cursor for a row that no longer exists (a pure sort tuple)', () => {
    const cursor = encodeAuditCursor({
      createdAt: new Date('2026-09-29T12:30:00.000Z'),
      id: 'deleted-audit-row',
    });

    expect(decodeAuditCursor(cursor)).toMatchObject({ id: 'deleted-audit-row' });
    expect(auditListQuerySchema.safeParse({ cursor }).success).toBe(true);
  });

  it('defaults to the configured page size, bounds the limit and rejects invalid ranges', () => {
    expect(auditListQuerySchema.parse({}).limit).toBe(AUDIT_DEFAULT_PAGE_SIZE);
    expect(auditListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(auditListQuerySchema.safeParse({ limit: AUDIT_MAX_PAGE_SIZE + 1 }).success).toBe(false);
    expect(auditListQuerySchema.safeParse({ limit: Number.MAX_SAFE_INTEGER }).success).toBe(false);
    expect(auditTimelineQuerySchema.safeParse({ limit: AUDIT_MAX_PAGE_SIZE }).success).toBe(true);
    expect(
      auditListQuerySchema.safeParse({
        from: '2026-09-30T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      auditTimelineQuerySchema.safeParse({
        from: '2026-09-30T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('accepts an inclusive range with equal boundaries and all five filters', () => {
    const result = auditListQuerySchema.safeParse({
      actorId: 'user-1',
      action: 'TRANSFER',
      resourceType: 'Transaction',
      resourceId: 'tx-1',
      from: '2026-09-29T12:00:00.000Z',
      to: '2026-09-29T12:00:00.000Z',
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.resourceType).toBe('Transaction');
  });
});
