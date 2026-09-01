import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BudgetResetService } from '../services/budget-reset.service';

/**
 * Runs on a periodic schedule (every hour) to evaluate recurring budgets and
 * reset their accumulated spend when the configured period has elapsed.
 *
 * Uses an in-process interval rather than BullMQ repeatable jobs because the
 * reset logic is lightweight, tightly coupled to the Prisma client, and must
 * not be missed or duplicated across queue workers.  The interval is `unref`'d
 * so it never keeps the Node process alive on its own.
 */
@Injectable()
export class BudgetResetWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BudgetResetWorker.name);
  private timer?: NodeJS.Timeout;

  /** Check for expired periods every hour. */
  private static readonly INTERVAL_MS = 60 * 60 * 1_000;

  constructor(private readonly resetService: BudgetResetService) {}

  onModuleInit(): void {
    this.logger.log('Budget reset worker started — checking every hour');
    this.timer = setInterval(() => {
      void this.resetService.runReset().catch((error) => {
        this.logger.error(`Scheduled budget reset failed: ${(error as Error).message}`);
      });
    }, BudgetResetWorker.INTERVAL_MS);
    // Prevent the timer from keeping the process alive during shutdown.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
