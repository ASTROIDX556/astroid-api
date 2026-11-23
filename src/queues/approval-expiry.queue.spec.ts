import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { APPROVAL_EXPIRY_JOB_NAME, ApprovalExpiryQueue, approvalExpiryJobId } from './approval-expiry.queue';

describe('ApprovalExpiryQueue', () => {
  let queue: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-23T10:00:00.000Z'));
    queue = { add: vi.fn().mockResolvedValue({ id: 'job' }), remove: vi.fn().mockResolvedValue(1) };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules a delayed job keyed by the proposal id', async () => {
    const producer = new ApprovalExpiryQueue(queue as unknown as Queue);
    const expiresAt = new Date('2026-11-23T11:00:00.000Z');

    await producer.schedule({ proposalId: 'p-1', organizationId: 'org-1', expiresAt });

    expect(queue.add).toHaveBeenCalledWith(
      APPROVAL_EXPIRY_JOB_NAME,
      { proposalId: 'p-1', organizationId: 'org-1', expiresAt: expiresAt.toISOString() },
      expect.objectContaining({ jobId: approvalExpiryJobId('p-1'), delay: 3_600_000 }),
    );
  });

  it('uses the same deterministic job id on duplicate scheduling', async () => {
    const producer = new ApprovalExpiryQueue(queue as unknown as Queue);
    const expiresAt = new Date('2026-11-23T11:00:00.000Z');

    await producer.schedule({ proposalId: 'p-1', organizationId: 'org-1', expiresAt });
    await producer.schedule({ proposalId: 'p-1', organizationId: 'org-1', expiresAt });

    const ids = queue.add.mock.calls.map(([, , opts]) => (opts as { jobId: string }).jobId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toContain(':');
  });

  it('clamps a deadline in the past to an immediate job', async () => {
    const producer = new ApprovalExpiryQueue(queue as unknown as Queue);

    await producer.schedule({ proposalId: 'p-1', organizationId: 'org-1', expiresAt: new Date('2026-11-23T09:00:00.000Z') });

    expect(queue.add.mock.calls[0][2]).toMatchObject({ delay: 0 });
  });

  it('removes the job on cancel', async () => {
    const producer = new ApprovalExpiryQueue(queue as unknown as Queue);

    await producer.cancel('p-1');

    expect(queue.remove).toHaveBeenCalledWith(approvalExpiryJobId('p-1'));
  });

  it('never throws when Redis is unavailable', async () => {
    queue.add.mockRejectedValue(new Error('ECONNREFUSED'));
    queue.remove.mockRejectedValue(new Error('ECONNREFUSED'));
    const producer = new ApprovalExpiryQueue(queue as unknown as Queue);

    await expect(
      producer.schedule({ proposalId: 'p-1', organizationId: 'org-1', expiresAt: new Date() }),
    ).resolves.toBeUndefined();
    await expect(producer.cancel('p-1')).resolves.toBeUndefined();
  });

  it('is a no-op without a queue', async () => {
    const producer = new ApprovalExpiryQueue();
    await expect(
      producer.schedule({ proposalId: 'p-1', organizationId: 'org-1', expiresAt: new Date() }),
    ).resolves.toBeUndefined();
    await expect(producer.cancel('p-1')).resolves.toBeUndefined();
  });
});
