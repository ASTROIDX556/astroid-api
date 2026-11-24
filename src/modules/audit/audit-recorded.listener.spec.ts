import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditRecordedListener } from './audit-recorded.listener';
import { AuditService } from './audit.service';
import { AuditRecordedPayload } from '../../events/domain-event.types';

function buildPayload(overrides: Partial<AuditRecordedPayload> = {}): AuditRecordedPayload {
  return {
    action: 'AGENT_KEY_ROTATED',
    organizationId: 'org-1',
    entity: 'ApiKey',
    entityId: 'key-1',
    method: 'POST',
    url: '/api/v1/developers/keys/key-1/rotate',
    statusCode: 200,
    success: true,
    userId: 'user-1',
    agentId: null,
    ipAddress: '127.0.0.1',
    userAgent: 'TestAgent/1.0',
    requestId: 'request-1',
    traceId: 'trace-1',
    durationMs: 12,
    occurredAt: '2026-10-01T10:00:00.000Z',
    body: { rotated: true },
    params: { id: 'key-1' },
    query: {},
    ...overrides,
  };
}

describe('AuditRecordedListener', () => {
  let listener: AuditRecordedListener;
  let auditService: { record: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    auditService = { record: vi.fn().mockResolvedValue(undefined) };
    listener = new AuditRecordedListener(auditService as unknown as AuditService);
  });

  it('persists the semantic action and the request metadata', async () => {
    await listener.handleAuditRecorded(buildPayload());

    expect(auditService.record).toHaveBeenCalledTimes(1);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        userId: 'user-1',
        action: 'AGENT_KEY_ROTATED',
        entity: 'ApiKey',
        entityId: 'key-1',
        ipAddress: '127.0.0.1',
        device: 'TestAgent/1.0',
        requestId: 'request-1',
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
        newValue: expect.objectContaining({
          method: 'POST',
          url: '/api/v1/developers/keys/key-1/rotate',
          statusCode: 200,
          success: true,
          durationMs: 12,
          body: { rotated: true },
        }),
      }),
    );
  });

  it('ignores events without an action', async () => {
    await listener.handleAuditRecorded({} as AuditRecordedPayload);

    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('ignores events without an organization context', async () => {
    await listener.handleAuditRecorded(buildPayload({ organizationId: undefined }));

    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('never propagates a persistence failure to the caller', async () => {
    auditService.record = vi.fn().mockRejectedValue(new Error('db down'));

    await expect(listener.handleAuditRecorded(buildPayload())).resolves.toBeUndefined();
  });
});
