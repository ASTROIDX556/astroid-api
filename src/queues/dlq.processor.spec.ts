import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Job, Queue } from 'bullmq';
import { DlqProcessor } from './dlq.processor';
import { DlqJobData, Queues } from './queues.constants';

describe('DlqProcessor', () => {
  let processor: DlqProcessor;
  let mockPrisma: Record<string, unknown>;
  let mockDomainEventCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDomainEventCreate = vi.fn().mockResolvedValue({ id: 'event-1' });
    mockPrisma = {
      domainEvent: {
        create: mockDomainEventCreate,
      },
    };
    processor = new DlqProcessor(mockPrisma as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('process', () => {
    it('processes a dead-letter job, logs details, and records an audit domain event', async () => {
      const mockJobData: DlqJobData = {
        originalQueue: Queues.Webhooks,
        originalJobId: 'job-123',
        originalJobName: 'deliver-webhook',
        payload: { webhookId: 'wh-1', event: 'payment.completed' },
        failedReason: 'HTTP 500: Internal Server Error',
        stacktrace: ['Error: HTTP 500 at fetch'],
        attemptsMade: 5,
        failedAt: '2026-08-30T21:00:00.000Z',
      };

      const mockJob = {
        id: 'dlq-job-1',
        data: mockJobData,
      } as unknown as Job<DlqJobData>;

      const result = await processor.process(mockJob);

      expect(result.handled).toBe(true);
      expect(result.deadLetteredAt).toBe('2026-08-30T21:00:00.000Z');
      expect(mockDomainEventCreate).toHaveBeenCalledWith({
        data: {
          name: 'job.dead_lettered',
          aggregateType: 'DEAD_LETTER_QUEUE',
          aggregateId: 'job-123',
          payload: {
            originalQueue: Queues.Webhooks,
            originalJobName: 'deliver-webhook',
            failedReason: 'HTTP 500: Internal Server Error',
            attemptsMade: 5,
            failedAt: '2026-08-30T21:00:00.000Z',
          },
        },
      });
    });

    it('gracefully handles missing database client without throwing errors', async () => {
      const processorNoDb = new DlqProcessor(undefined);
      const mockJobData: DlqJobData = {
        originalQueue: Queues.Transactions,
        originalJobId: 'tx-456',
        payload: { transactionId: 'tx-456' },
        failedReason: 'Insufficient funds',
        attemptsMade: 3,
        failedAt: '2026-08-30T21:05:00.000Z',
      };

      const mockJob = {
        id: 'dlq-job-2',
        data: mockJobData,
      } as unknown as Job<DlqJobData>;

      const result = await processorNoDb.process(mockJob);
      expect(result.handled).toBe(true);
    });
  });

  describe('moveToDeadLetter static helper', () => {
    it('constructs correct DlqJobData and adds job to the DLQ queue', async () => {
      const mockDlqQueue = {
        add: vi.fn().mockResolvedValue({ id: 'dlq-added-1' }),
      } as unknown as Queue<DlqJobData>;

      const originalFailedJob = {
        id: 'orig-job-999',
        name: 'sync-stellar-balance',
        data: { walletId: 'wallet-1', address: 'GABC123' },
        attemptsMade: 3,
        stacktrace: ['Error: Horizon connection timeout'],
        timestamp: 1725050000000,
        processedOn: 1725050001000,
        finishedOn: 1725050005000,
      } as unknown as Job;

      const error = new Error('Horizon connection timeout');

      const result = await DlqProcessor.moveToDeadLetter(
        mockDlqQueue,
        originalFailedJob,
        error,
        Queues.StellarSync,
      );

      expect(mockDlqQueue.add).toHaveBeenCalledWith(
        expect.stringContaining('dlq:stellar-sync:orig-job-999'),
        expect.objectContaining({
          originalQueue: Queues.StellarSync,
          originalJobId: 'orig-job-999',
          originalJobName: 'sync-stellar-balance',
          payload: { walletId: 'wallet-1', address: 'GABC123' },
          failedReason: 'Horizon connection timeout',
          attemptsMade: 3,
        }),
        expect.any(Object),
      );
      expect(result).toEqual({ id: 'dlq-added-1' });
    });
  });
});
