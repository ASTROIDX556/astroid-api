import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';

interface OutboxEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  retryCount: number;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  // Ideally injected, but using direct instantiate for the sake of the task if not provided globally
  private readonly prisma = new PrismaClient(); 

  constructor(
    @InjectQueue('outbox-events') private readonly outboxQueue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async processOutboxEvents() {
    try {
      // Fetch pending events with FOR UPDATE SKIP LOCKED
      // Prisma raw query is needed for this specific lock
      const pendingEvents = await this.prisma.$queryRaw<OutboxEvent[]>`
        SELECT * FROM "outbox_events"
        WHERE status = 'PENDING' OR (status = 'FAILED' AND "retryCount" < 3)
        ORDER BY "createdAt" ASC
        LIMIT 50
        FOR UPDATE SKIP LOCKED;
      `;

      if (pendingEvents.length === 0) {
        return;
      }

      this.logger.log(`Processing ${pendingEvents.length} outbox events...`);

      for (const event of pendingEvents) {
        try {
          await this.outboxQueue.add(event.eventType, event.payload, {
            jobId: `outbox-${event.id}`,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 1000,
            }
          });

          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: 'COMPLETED',
              processedAt: new Date(),
            },
          });
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const errorStack = error instanceof Error ? error.stack : undefined;
          this.logger.error(`Failed to enqueue outbox event ${event.id}:`, errorStack);
          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: 'FAILED',
              retryCount: event.retryCount + 1,
              error: errorMessage,
            },
          });
        }
      }
    } catch (error) {
      this.logger.error('Error processing outbox events:', error);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupProcessedEvents() {
    this.logger.log('Cleaning up processed outbox events older than 24 hours...');
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const result = await this.prisma.outboxEvent.deleteMany({
      where: {
        status: 'COMPLETED',
        processedAt: {
          lt: twentyFourHoursAgo,
        },
      },
    });

    this.logger.log(`Cleaned up ${result.count} processed outbox events.`);
  }
}
