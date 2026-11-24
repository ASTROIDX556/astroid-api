import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Queues } from './queues.constants';

/**
 * Job name of the delayed per-proposal expiry job. It shares the
 * {@link Queues.ApprovalSweep} queue with the periodic sweep, which stays in
 * place as a backstop for jobs lost to a Redis flush or proposals created
 * before this job existed.
 */
export const APPROVAL_EXPIRY_JOB_NAME = 'approval-expire';

export interface ApprovalExpiryJobData {
  proposalId: string;
  organizationId: string;
  /** ISO timestamp the job was scheduled for. */
  expiresAt: string;
}

/**
 * Deterministic job id: scheduling the same proposal twice is a no-op in
 * BullMQ, and a decision can remove the job without having stored its id.
 */
export function approvalExpiryJobId(proposalId: string): string {
  return `${APPROVAL_EXPIRY_JOB_NAME}-${proposalId}`;
}

/**
 * Schedules and cancels the delayed expiry job of an approval proposal.
 *
 * Both operations are best effort and never throw: the expiry itself is a
 * guarded `PENDING -> EXPIRED` compare-and-set, so a job that fires after a
 * decision is harmless, and a job that was never scheduled is picked up by the
 * periodic sweep. A Redis outage therefore cannot fail transaction creation
 * or an approval decision.
 */
@Injectable()
export class ApprovalExpiryQueue {
  private readonly logger = new Logger(ApprovalExpiryQueue.name);

  constructor(@Optional() @InjectQueue(Queues.ApprovalSweep) private readonly queue?: Queue) {}

  async schedule(data: { proposalId: string; organizationId: string; expiresAt: Date }): Promise<void> {
    if (!this.queue) return;
    const delay = Math.max(data.expiresAt.getTime() - Date.now(), 0);
    try {
      await this.queue.add(
        APPROVAL_EXPIRY_JOB_NAME,
        {
          proposalId: data.proposalId,
          organizationId: data.organizationId,
          expiresAt: data.expiresAt.toISOString(),
        } satisfies ApprovalExpiryJobData,
        {
          jobId: approvalExpiryJobId(data.proposalId),
          delay,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 1_000 },
          removeOnFail: { count: 1_000 },
        },
      );
    } catch (error) {
      this.logger.warn(
        `Could not schedule expiry for proposal ${data.proposalId}; the periodic sweep will expire it: ${(error as Error).message}`,
      );
    }
  }

  async cancel(proposalId: string): Promise<void> {
    if (!this.queue) return;
    try {
      await this.queue.remove(approvalExpiryJobId(proposalId));
    } catch (error) {
      // An active (running) job cannot be removed; its guarded transition
      // will no-op because the proposal is no longer PENDING.
      this.logger.debug(
        `Could not remove expiry job for proposal ${proposalId}: ${(error as Error).message}`,
      );
    }
  }
}
