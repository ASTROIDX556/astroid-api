import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeadLetterController } from './dead-letter.controller';
import { Queues } from '../../queues/queues.constants';

function buildMockService() {
  return {
    listForOrganization: vi.fn().mockResolvedValue([{ id: 'evt-1' }]),
    requeue: vi.fn().mockResolvedValue({
      queue: Queues.Webhooks,
      jobId: 'job-123',
      requeuedJobId: 'dlq-retry-job-123-1',
    }),
    purge: vi.fn().mockResolvedValue({
      queue: Queues.Webhooks,
      jobId: 'job-123',
      purged: true as const,
    }),
  };
}

describe('DeadLetterController', () => {
  let controller: DeadLetterController;
  let service: ReturnType<typeof buildMockService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = buildMockService();
    controller = new DeadLetterController(service as never);
  });

  it('lists DLQ events scoped to the current organization', async () => {
    const result = await controller.list('org-1', Queues.Webhooks, '10');

    expect(service.listForOrganization).toHaveBeenCalledWith('org-1', Queues.Webhooks, 10);
    expect(result).toEqual([{ id: 'evt-1' }]);
  });

  it('re-drives a failed job through the service', async () => {
    const result = await controller.retry(Queues.Webhooks, 'job-123');

    expect(service.requeue).toHaveBeenCalledWith(Queues.Webhooks, 'job-123');
    expect(result.requeuedJobId).toContain('dlq-retry-job-123');
  });

  it('purges a failed job through the service', async () => {
    const result = await controller.purge(Queues.Webhooks, 'job-123');

    expect(service.purge).toHaveBeenCalledWith(Queues.Webhooks, 'job-123');
    expect(result.purged).toBe(true);
  });
});