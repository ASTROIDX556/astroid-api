import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookCircuitStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { RedisLock, LockRelease } from '../../../common/locks/redis-lock.util';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { DEFAULT_WEBHOOK_CONFIG, WebhookConfig } from '../../../config/webhook.config';
import { WebhookFailureCategory } from '../utils/failure-classification';

/** Lock key prefix of the per-endpoint circuit lock. */
const CIRCUIT_LOCK_PREFIX = 'webhook:circuit';

/** How long the per-endpoint lock is held (ms). */
const CIRCUIT_LOCK_TTL_MS = 5_000;

/** How many times the lock is retried before the caller proceeds without it. */
const CIRCUIT_LOCK_ATTEMPTS = 3;

/**
 * The state of one webhook endpoint's circuit, as persisted in
 * `webhook_circuit_states`.
 */
export interface WebhookCircuitSnapshot {
  webhookId: string;
  organizationId: string;
  status: WebhookCircuitStatus;
  consecutiveFailures: number;
  totalFailures: number;
  openedAt: Date | null;
  cooldownEndsAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureCode: string | null;
  lastFailureReason: string | null;
  lastSuccessAt: Date | null;
}

/**
 * The decision taken before a delivery attempt.
 *
 * `allowed` is false while the circuit is open, which means the delivery must
 * not touch the endpoint. `retryAt` is the moment the cooldown ends and a
 * probe delivery becomes allowed again.
 */
export interface WebhookCircuitDecision {
  /** True when the delivery may be attempted. */
  allowed: boolean;
  /** The circuit state the decision was taken in. */
  status: WebhookCircuitStatus;
  /** Consecutive failures recorded for the endpoint. */
  consecutiveFailures: number;
  /** When the cooldown ends — only set when the delivery was not allowed. */
  retryAt?: Date;
}

/** One failed delivery attempt, recorded against the endpoint. */
export interface WebhookCircuitFailure {
  /** Machine-readable reason (e.g. `HTTP_503`, `TIMEOUT`). */
  code: string;
  /** Broad class of the failure. */
  category: WebhookFailureCategory;
  /** Human-readable reason. Never contains the payload or the secret. */
  reason: string;
  /** The HTTP status the endpoint answered with, when any. */
  responseStatus?: number;
}

/** The outcome of recording a failed attempt. */
export interface WebhookCircuitFailureOutcome {
  /** The circuit state after the failure was recorded. */
  status: WebhookCircuitStatus;
  /** Consecutive failures after the failure was recorded. */
  consecutiveFailures: number;
  /** True when this failure opened (or re-opened) the circuit. */
  opened: boolean;
}

/**
 * Per-endpoint circuit breaker for outbound webhook deliveries.
 *
 * The breaker protects a single subscriber endpoint from being hammered while
 * it is down:
 *
 *  - **CLOSED** — deliveries are attempted normally. Every failed attempt
 *    increments the consecutive failure counter.
 *  - **OPEN** — the endpoint reached the configured threshold of consecutive
 *    failures. Deliveries are *not* attempted; the caller defers them until
 *    the cooldown ends, so no attempt budget is consumed.
 *  - **HALF_OPEN** — the cooldown elapsed. A probe delivery is allowed. A
 *    successful probe closes the circuit and resets the counter; a failed probe
 *    opens it again for another cooldown.
 *
 * The state lives in PostgreSQL (`webhook_circuit_states`), so it survives a
 * worker restart and is shared by every worker of a multi-instance deployment.
 * The transitions are written with conditional updates so a concurrent burst of
 * failures can only open the circuit once and can never push an already open
 * cooldown further away.
 */
@Injectable()
export class WebhookCircuitService {
  private readonly logger = new Logger(WebhookCircuitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() private readonly eventBus?: EventBusService,
    @Optional() private readonly lock?: RedisLock,
  ) {}

  /** The resolved webhook configuration. */
  private get settings(): WebhookConfig {
    return this.config.get<WebhookConfig>('webhook') ?? DEFAULT_WEBHOOK_CONFIG;
  }

  /** True when the circuit breaker is active. */
  get enabled(): boolean {
    return this.settings.circuitEnabled;
  }

  /** The number of consecutive failures that opens the circuit. */
  get failureThreshold(): number {
    return this.settings.circuitFailureThreshold;
  }

  /** How long the circuit stays open (ms). */
  get cooldownMs(): number {
    return this.settings.circuitCooldownMs;
  }

  /**
   * Decides whether a delivery may be attempted.
   *
   * When the cooldown has elapsed the circuit moves to HALF_OPEN and the
   * caller may run a single probe delivery.
   */
  async beforeAttempt(
    webhookId: string,
    now: Date = new Date(),
  ): Promise<WebhookCircuitDecision> {
    if (!this.enabled) {
      return { allowed: true, status: WebhookCircuitStatus.CLOSED, consecutiveFailures: 0 };
    }

    return this.withEndpointLock(webhookId, async () => {
      const state = await this.load(webhookId);
      if (!state) {
        return { allowed: true, status: WebhookCircuitStatus.CLOSED, consecutiveFailures: 0 };
      }

      if (state.status === WebhookCircuitStatus.OPEN) {
        const cooldownEndsAt = state.cooldownEndsAt ?? now;
        if (now < cooldownEndsAt) {
          return {
            allowed: false,
            status: WebhookCircuitStatus.OPEN,
            consecutiveFailures: state.consecutiveFailures,
            retryAt: cooldownEndsAt,
          };
        }

        // The cooldown elapsed: move to half-open and allow a probe delivery.
        // The transition is conditional on the circuit still being open with
        // the very same cooldown, so a failure that re-opened it in the
        // meantime is never overwritten by a stale decision.
        const halfOpened = await this.client.webhookCircuitState.updateMany({
          where: {
            webhookId,
            status: WebhookCircuitStatus.OPEN,
            cooldownEndsAt,
          },
          data: {
            status: WebhookCircuitStatus.HALF_OPEN,
            openedAt: null,
            // The lease of the probe: until it expires no other delivery may
            // probe the endpoint, and an expired lease means the probe was
            // lost and a new one is allowed.
            cooldownEndsAt: new Date(now.getTime() + this.cooldownMs),
          },
        });

        if (halfOpened.count === 0) {
          // The circuit was re-opened while the decision was taken: the
          // delivery waits for the new cooldown instead of probing.
          const current = await this.load(webhookId);
          return {
            allowed: false,
            status: current?.status ?? WebhookCircuitStatus.OPEN,
            consecutiveFailures: current?.consecutiveFailures ?? state.consecutiveFailures,
            retryAt: current?.cooldownEndsAt ?? cooldownEndsAt,
          };
        }

        return {
          allowed: true,
          status: WebhookCircuitStatus.HALF_OPEN,
          consecutiveFailures: state.consecutiveFailures,
        };
      }

      if (state.status === WebhookCircuitStatus.HALF_OPEN) {
        // A probe delivery is already in flight: the lease of the probe has
        // not expired yet, so the delivery waits instead of probing again.
        const probeLeaseEndsAt = state.cooldownEndsAt ?? new Date(now.getTime() + this.cooldownMs);
        if (now < probeLeaseEndsAt) {
          return {
            allowed: false,
            status: WebhookCircuitStatus.HALF_OPEN,
            consecutiveFailures: state.consecutiveFailures,
            retryAt: probeLeaseEndsAt,
          };
        }

        // The probe was lost (the worker died or the job was deferred): allow
        // a new probe and refresh the lease.
        const halfOpened = await this.client.webhookCircuitState.updateMany({
          where: { webhookId, status: WebhookCircuitStatus.HALF_OPEN },
          data: { cooldownEndsAt: new Date(now.getTime() + this.cooldownMs) },
        });
        if (halfOpened.count === 0) {
          const current = await this.load(webhookId);
          return {
            allowed: false,
            status: current?.status ?? WebhookCircuitStatus.HALF_OPEN,
            consecutiveFailures: current?.consecutiveFailures ?? state.consecutiveFailures,
            retryAt: current?.cooldownEndsAt ?? probeLeaseEndsAt,
          };
        }

        return {
          allowed: true,
          status: WebhookCircuitStatus.HALF_OPEN,
          consecutiveFailures: state.consecutiveFailures,
        };
      }

      return {
        allowed: true,
        status: state.status,
        consecutiveFailures: state.consecutiveFailures,
      };
    });
  }

  /**
   * Records a failed delivery attempt and opens the circuit when the
   * configured threshold of consecutive failures is reached.
   */
  async recordFailure(
    webhookId: string,
    organizationId: string,
    failure: WebhookCircuitFailure,
    url?: string,
    now: Date = new Date(),
  ): Promise<WebhookCircuitFailureOutcome> {
    if (!this.enabled) {
      return {
        status: WebhookCircuitStatus.CLOSED,
        consecutiveFailures: 0,
        opened: false,
      };
    }

    return this.withEndpointLock(webhookId, async () => {
      const previous = await this.load(webhookId);
      const updated = await this.incrementFailures(webhookId, organizationId, failure, now);

      // A failed probe delivery always re-opens the circuit, even when the
      // counter was reset in the meantime.
      const shouldOpen =
        previous?.status === WebhookCircuitStatus.HALF_OPEN ||
        updated.consecutiveFailures >= this.failureThreshold;

      if (!shouldOpen) {
        return {
          status: updated.status,
          consecutiveFailures: updated.consecutiveFailures,
          opened: false,
        };
      }

      const cooldownEndsAt = new Date(now.getTime() + this.cooldownMs);
      const opened = await this.transitionToOpen(webhookId, now, cooldownEndsAt);

      if (opened) {
        this.logger.warn(
          `Webhook circuit opened for ${webhookId} after ${updated.consecutiveFailures} consecutive failure(s); ` +
            `deliveries are paused until ${cooldownEndsAt.toISOString()}`,
        );
        await this.emitCircuitOpened({
          webhookId,
          organizationId,
          url,
          consecutiveFailures: updated.consecutiveFailures,
          cooldownEndsAt,
          failureCode: failure.code,
        });
      }

      return {
        status: opened ? WebhookCircuitStatus.OPEN : updated.status,
        consecutiveFailures: updated.consecutiveFailures,
        opened,
      };
    });
  }

  /**
   * Records a successful delivery: the failure counter is reset and a circuit
   * that was open or half-open is closed again.
   */
  async recordSuccess(
    webhookId: string,
    organizationId: string,
    url?: string,
    now: Date = new Date(),
  ): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await this.withEndpointLock(webhookId, async () => {
      // An already closed circuit only needs its counter reset.
      await this.client.webhookCircuitState.updateMany({
        where: { webhookId, status: WebhookCircuitStatus.CLOSED },
        data: { consecutiveFailures: 0, lastSuccessAt: now },
      });

      // Closing an open circuit is a compare-and-set: only the transition that
      // actually changes the state reports the recovery.
      const previous = await this.load(webhookId);
      const closed = await this.client.webhookCircuitState.updateMany({
        where: { webhookId, status: { in: [WebhookCircuitStatus.OPEN, WebhookCircuitStatus.HALF_OPEN] } },
        data: {
          status: WebhookCircuitStatus.CLOSED,
          consecutiveFailures: 0,
          openedAt: null,
          cooldownEndsAt: null,
          lastSuccessAt: now,
        },
      });

      if (closed.count > 0) {
        this.logger.log(`Webhook circuit closed for ${webhookId} after a successful delivery`);
        await this.emitCircuitClosed({
          webhookId,
          organizationId,
          url,
          previousStatus: previous?.status ?? null,
        });
      }
    });
  }

  /** The persisted state of an endpoint's circuit, for diagnostics. */
  async getState(webhookId: string): Promise<WebhookCircuitSnapshot | null> {
    const state = await this.load(webhookId);
    if (!state) {
      return null;
    }
    return {
      webhookId: state.webhookId,
      organizationId: state.organizationId,
      status: state.status,
      consecutiveFailures: state.consecutiveFailures,
      totalFailures: state.totalFailures,
      openedAt: state.openedAt,
      cooldownEndsAt: state.cooldownEndsAt,
      lastFailureAt: state.lastFailureAt,
      lastFailureCode: state.lastFailureCode,
      lastFailureReason: state.lastFailureReason,
      lastSuccessAt: state.lastSuccessAt,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** The Prisma client used for background writes. */
  private get client(): PrismaService {
    return (this.prisma.workerClient ?? this.prisma) as PrismaService;
  }

  /** Loads the persisted circuit state of an endpoint. */
  private async load(webhookId: string) {
    return this.client.webhookCircuitState.findUnique({ where: { webhookId } });
  }

  /**
   * Increments the failure counters of an endpoint.
   *
   * The increment is atomic, so a concurrent burst of failures can never lose
   * a count.
   */
  private async incrementFailures(
    webhookId: string,
    organizationId: string,
    failure: WebhookCircuitFailure,
    now: Date,
  ) {
    await this.client.webhookCircuitState.createMany({
      data: [
        {
          webhookId,
          organizationId,
          status: WebhookCircuitStatus.CLOSED,
          consecutiveFailures: 0,
          totalFailures: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
      skipDuplicates: true,
    });

    return this.client.webhookCircuitState.update({
      where: { webhookId },
      data: {
        consecutiveFailures: { increment: 1 },
        totalFailures: { increment: 1 },
        lastFailureAt: now,
        lastFailureCode: failure.code,
        lastFailureReason: failure.reason,
      },
    });
  }

  /**
   * Moves an endpoint's circuit into the open state.
   *
   * The update is conditional on the circuit not being open already, so a
   * concurrent burst of failures opens it exactly once and never extends a
   * cooldown that is already running.
   *
   * @returns true when this call performed the transition.
   */
  private async transitionToOpen(
    webhookId: string,
    now: Date,
    cooldownEndsAt: Date,
  ): Promise<boolean> {
    const result = await this.client.webhookCircuitState.updateMany({
      where: {
        webhookId,
        status: { in: [WebhookCircuitStatus.CLOSED, WebhookCircuitStatus.HALF_OPEN] },
      },
      data: {
        status: WebhookCircuitStatus.OPEN,
        openedAt: now,
        cooldownEndsAt,
      },
    });
    return result.count > 0;
  }

  /**
   * Runs a block while holding the per-endpoint lock.
   *
   * The lock serialises the state transitions of one endpoint. It is
   * best-effort: when the lock cannot be acquired the block still runs,
   * because the conditional database updates keep the state consistent on
   * their own.
   *
   * The lock is acquired *before* the block runs, and a failure of the block
   * itself is never mistaken for a failure to acquire the lock — otherwise the
   * block would run twice and every failure would be counted twice.
   */
  private async withEndpointLock<T>(webhookId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.lock) {
      return fn();
    }

    let release: LockRelease;
    try {
      release = await this.lock.acquire(
        `${CIRCUIT_LOCK_PREFIX}:${webhookId}`,
        CIRCUIT_LOCK_TTL_MS,
        CIRCUIT_LOCK_ATTEMPTS,
        50,
      );
    } catch (error) {
      this.logger.warn(
        `Could not acquire the circuit lock for webhook ${webhookId}: ${(error as Error).message}`,
      );
      return fn();
    }

    try {
      return await fn();
    } finally {
      await release();
    }
  }

  /** Emits the domain event that reports the temporarily open circuit. */
  private async emitCircuitOpened(input: {
    webhookId: string;
    organizationId: string;
    url?: string;
    consecutiveFailures: number;
    cooldownEndsAt: Date;
    failureCode?: string;
  }): Promise<void> {
    if (!this.eventBus) {
      return;
    }
    try {
      await this.eventBus.emit(
        DomainEventName.WebhookCircuitOpened,
        {
          webhookId: input.webhookId,
          url: redactWebhookUrl(input.url),
          status: WebhookCircuitStatus.OPEN,
          consecutiveFailures: input.consecutiveFailures,
          threshold: this.failureThreshold,
          cooldownEndsAt: input.cooldownEndsAt.toISOString(),
          failureCode: input.failureCode ?? null,
        },
        {
          organizationId: input.organizationId,
          aggregateType: 'webhook',
          aggregateId: input.webhookId,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Could not emit the webhook circuit event for ${input.webhookId}: ${(error as Error).message}`,
      );
    }
  }

  /** Emits the domain event that reports the recovered circuit. */
  private async emitCircuitClosed(input: {
    webhookId: string;
    organizationId: string;
    url?: string;
    previousStatus?: string | null;
  }): Promise<void> {
    if (!this.eventBus) {
      return;
    }
    try {
      await this.eventBus.emit(
        DomainEventName.WebhookCircuitClosed,
        {
          webhookId: input.webhookId,
          url: redactWebhookUrl(input.url),
          status: WebhookCircuitStatus.CLOSED,
          previousStatus: input.previousStatus ?? null,
        },
        {
          organizationId: input.organizationId,
          aggregateType: 'webhook',
          aggregateId: input.webhookId,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Could not emit the webhook circuit event for ${input.webhookId}: ${(error as Error).message}`,
      );
    }
  }
}

/**
 * The subscriber URL without its query string.
 *
 * A subscriber may embed a shared secret in the query string of its endpoint,
 * and the circuit events are persisted in the domain-event ledger and copied
 * into the audit trail. Only the origin and the path are reported.
 */
export function redactWebhookUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/** Re-exported so callers do not need to import the Prisma enum directly. */
export { WebhookCircuitStatus };
