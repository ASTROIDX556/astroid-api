import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { PolicyOverrideExpiredEvent } from '../policy-override-expired.event';

// One hour in milliseconds, used to schedule the periodic sweeps.
const ONE_HOUR_MS = 60 * 60 * 1000;

// The subset of a Policy row the cleanup needs to decide on a reset.
interface ExpiredOverrideRow {
  id: string;
  organizationId: string;
  overrideLimit: Prisma.Decimal | null;
  overrideUntil: Date | null;
  originalLimit: Prisma.Decimal | null;
}

// The result of terminating one expired override (also used to emit the event).
export interface OverrideResetResult {
  policyId: string;
  organizationId: string;
  previousLimit: number;
  restoredLimit: number;
}

// Terminates expired temporary spending overrides (issue #21). Runs on a
// periodic schedule and, for every policy whose override window has lapsed:
//   1. restores the configured max amount to the pre-override limit,
//   2. clears overrideLimit / overrideUntil / originalLimit,
//   3. appends an immutable audit record, and
//   4. emits a typed PolicyOverrideExpiredEvent.
// Each reset is idempotent and transactional: the guarded row update uses a
// where clause that re-checks the override is still expired, so an override
// that a concurrent request just extended is never clobbered.
@Injectable()
export class PolicyOverrideCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PolicyOverrideCleanupService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBusService,
  ) {}

  // Schedules the hourly sweep. Uses an in-process interval because this
  // repository has no @nestjs/schedule or real BullMQ wiring.
  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.runCleanup().catch((error) => {
        this.logger.error(`Policy override cleanup failed: ${(error as Error).message}`);
      });
    }, ONE_HOUR_MS);
    // The timer must not keep the process alive on its own.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // Resets every policy with an override window that has already expired.
  async runCleanup(now: Date = new Date()): Promise<OverrideResetResult[]> {
    const expired = await this.prisma.policy.findMany({
      where: {
        deletedAt: null,
        overrideLimit: { not: null },
        overrideUntil: { lt: now },
      },
      select: {
        id: true,
        organizationId: true,
        overrideLimit: true,
        overrideUntil: true,
        originalLimit: true,
      },
    });

    const results: OverrideResetResult[] = [];
    for (const row of expired) {
      const result = await this.resetExpired(row, now);
      if (result) {
        await this.notify(result, now);
        results.push(result);
      }
    }
    return results;
  }

  // Terminates a single expired override inside a transaction. Returns null
  // when the row is no longer eligible (e.g. a concurrent request extended it).
  // The immutable audit record is appended by the AuditListener when the
  // PolicyOverrideExpiredEvent is emitted (see notify()), the same event-driven
  // audit path used by every other domain action in this repo.
  private async resetExpired(
    row: ExpiredOverrideRow,
    now: Date,
  ): Promise<OverrideResetResult | null> {
    return this.prisma.$transaction(async (tx) => {
      const policy = await tx.policy.findUnique({ where: { id: row.id } });
      if (!policy) {
        return null;
      }

      const currentConfig = (policy.configuration as Record<string, unknown>) ?? {};
      const restoredLimit =
        policy.originalLimit != null
          ? policy.originalLimit.toNumber()
          : typeof currentConfig.maxAmount === 'number'
            ? currentConfig.maxAmount
            : 0;
      const previousLimit = policy.overrideLimit?.toNumber() ?? restoredLimit;

      // Guarded, atomic update: only touches rows whose override is still
      // expired, so a just-extended override is left alone.
      const updated = await tx.policy.updateMany({
        where: {
          id: row.id,
          overrideLimit: { not: null },
          overrideUntil: { lt: now },
        },
        data: {
          overrideLimit: null,
          overrideUntil: null,
          originalLimit: null,
          configuration: { ...currentConfig, maxAmount: restoredLimit },
        },
      });
      if (updated.count === 0) {
        return null;
      }

      return {
        policyId: row.id,
        organizationId: row.organizationId,
        previousLimit,
        restoredLimit,
      };
    });
  }

  // Emits the typed event after the reset transaction commits.
  private async notify(result: OverrideResetResult, now: Date): Promise<void> {
    const event = new PolicyOverrideExpiredEvent(
      result.policyId,
      result.previousLimit,
      result.restoredLimit,
      now,
    );
    await this.eventBus.emit(
      DomainEventName.PolicyOverrideExpired,
      { ...event },
      {
        organizationId: result.organizationId,
        aggregateType: 'policy',
        aggregateId: result.policyId,
      },
    );
  }
}
