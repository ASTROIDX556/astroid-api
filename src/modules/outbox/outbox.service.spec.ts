import { Test, TestingModule } from '@nestjs/testing';
import { OutboxService } from './outbox.service';
import { getQueueToken } from '@nestjs/bullmq';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('OutboxService', () => {
  let service: OutboxService;
  let queueMock: { add: ReturnType<typeof vi.fn> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prismaMock: Record<string, any>;

  beforeEach(async () => {
    queueMock = {
      add: vi.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        {
          provide: getQueueToken('outbox-events'),
          useValue: queueMock,
        },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
    
    // Mock Prisma Client
    prismaMock = {
      $queryRaw: vi.fn(),
      outboxEvent: {
        update: vi.fn(),
        deleteMany: vi.fn(),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).prisma = prismaMock;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should process pending outbox events successfully', async () => {
    const mockEvents = [
      { id: '1', eventType: 'TEST_EVENT', payload: { foo: 'bar' }, retryCount: 0 },
    ];
    
    prismaMock.$queryRaw.mockResolvedValue(mockEvents);
    prismaMock.outboxEvent.update.mockResolvedValue({});

    await service.processOutboxEvents();

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(queueMock.add).toHaveBeenCalledWith('TEST_EVENT', { foo: 'bar' }, expect.any(Object));
    expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: {
        status: 'COMPLETED',
        processedAt: expect.any(Date),
      },
    });
  });

  it('should handle enqueue failures and increment retry count', async () => {
    const mockEvents = [
      { id: '1', eventType: 'TEST_EVENT', payload: { foo: 'bar' }, retryCount: 0 },
    ];
    
    prismaMock.$queryRaw.mockResolvedValue(mockEvents);
    queueMock.add.mockRejectedValue(new Error('BullMQ connection failed'));
    prismaMock.outboxEvent.update.mockResolvedValue({});

    await service.processOutboxEvents();

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(queueMock.add).toHaveBeenCalledTimes(1);
    expect(prismaMock.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: {
        status: 'FAILED',
        retryCount: 1,
        error: 'BullMQ connection failed',
      },
    });
  });

  it('should cleanup processed events older than 24 hours', async () => {
    prismaMock.outboxEvent.deleteMany.mockResolvedValue({ count: 5 });

    await service.cleanupProcessedEvents();

    expect(prismaMock.outboxEvent.deleteMany).toHaveBeenCalledWith({
      where: {
        status: 'COMPLETED',
        processedAt: {
          lt: expect.any(Date),
        },
      },
    });
  });
});
