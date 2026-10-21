import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RiskBand } from '@prisma/client';

interface RiskAssessment {
  id: string;
  organizationId: string;
  transactionId: string;
  score: number;
  band: RiskBand;
  factors: Record<string, unknown>;
  canAutoExecute: boolean;
  createdAt: Date;
}

/** Prior payments an organization made to a destination address. */
export interface DestinationHistory {
  /** Payments that reached a terminal successful state. */
  successful: number;
  /** Payments that failed to settle. */
  failed: number;
}

/** Transaction activity of a wallet inside a trailing window. */
export interface WalletVelocity {
  /** Number of transactions in the window. */
  count: number;
  /** Total value moved in the window. */
  totalAmount: number;
}

/**
 * Repository for risk assessment persistence and historical analysis.
 * Stores risk evaluation results for compliance reporting and pattern detection,
 * and derives the raw signals the risk aggregator scores (velocity, destination
 * reputation and the amount baseline).
 */
@Injectable()
export class RiskRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a risk assessment result for audit trail compliance. The record is
   * keyed by the transaction, so re-assessing a transaction refreshes the
   * existing row instead of failing on the unique constraint.
   */
  async createAssessmentRecord(data: {
    organizationId: string;
    transactionId: string;
    score: number;
    band: RiskBand;
    factors: Record<string, unknown>;
    canAutoExecute: boolean;
  }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.prisma as any).riskAssessment.upsert({
      where: { transactionId: data.transactionId },
      create: {
        organizationId: data.organizationId,
        transactionId: data.transactionId,
        score: data.score,
        band: data.band,
        factors: data.factors,
        canAutoExecute: data.canAutoExecute,
      },
      update: {
        score: data.score,
        band: data.band,
        factors: data.factors,
        canAutoExecute: data.canAutoExecute,
      },
    });
  }

  /**
   * Get historical risk assessments for an organization.
   */
  async findByOrganization(organizationId: string, limit = 100) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.prisma as any).riskAssessment.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Get risk assessment by transaction ID.
   */
  async findByTransaction(transactionId: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.prisma as any).riskAssessment.findUnique({
      where: { transactionId },
    });
  }

  /**
   * Get risk statistics for an organization.
   */
  async getStatistics(organizationId: string, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assessments = await (this.prisma as any).riskAssessment.findMany({
      where: {
        organizationId,
        createdAt: { gte: since },
      },
    });

    const total = assessments.length;
    const byBand = {
      LOW: assessments.filter((a: RiskAssessment) => a.band === RiskBand.LOW).length,
      MEDIUM: assessments.filter((a: RiskAssessment) => a.band === RiskBand.MEDIUM).length,
      HIGH: assessments.filter((a: RiskAssessment) => a.band === RiskBand.HIGH).length,
      CRITICAL: assessments.filter((a: RiskAssessment) => a.band === RiskBand.CRITICAL).length,
    };

    const avgScore =
      total > 0 ? assessments.reduce((sum: number, a: RiskAssessment) => sum + a.score, 0) / total : 0;

    return {
      total,
      averageScore: Math.round(avgScore),
      byBand,
      autoExecuteRate: total > 0 ? assessments.filter((a: RiskAssessment) => a.canAutoExecute).length / total : 0,
    };
  }

  /**
   * Payment history with a destination address — the reputation signal. Counts
   * the payments that settled and the payments that failed to settle.
   */
  async getDestinationHistory(
    organizationId: string,
    recipientAddress: string,
  ): Promise<DestinationHistory> {
    const [successful, failed] = await Promise.all([
      this.prisma.transaction.count({
        where: {
          organizationId,
          recipientAddress,
          status: { in: ['COMPLETED', 'CONFIRMED', 'SUBMITTED'] },
        },
      }),
      this.prisma.transaction.count({
        where: {
          organizationId,
          recipientAddress,
          status: 'FAILED',
        },
      }),
    ]);
    return { successful, failed };
  }

  /**
   * Transaction count and value moved by a wallet inside the trailing window —
   * the velocity signal.
   */
  async getWalletVelocity(walletId: string, sinceHours = 24): Promise<WalletVelocity> {
    const since = new Date(Date.now() - sinceHours * 3_600_000);
    const [count, aggregate] = await Promise.all([
      this.prisma.transaction.count({
        where: { walletId, createdAt: { gte: since } },
      }),
      this.prisma.transaction.aggregate({
        where: { walletId, createdAt: { gte: since } },
        _sum: { amount: true },
      }),
    ]);
    const total = aggregate._sum.amount;
    return {
      count,
      totalAmount: total === null || total === undefined ? 0 : Number(total.toString()),
    };
  }

  /**
   * Average amount of the wallet's transactions inside the trailing window —
   * the baseline the amount-anomaly signal compares against. Returns null when
   * the wallet has no history to compare with.
   */
  async getAmountBaseline(walletId: string, sinceDays = 90): Promise<number | null> {
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    const aggregate = await this.prisma.transaction.aggregate({
      where: { walletId, createdAt: { gte: since } },
      _avg: { amount: true },
    });
    const average = aggregate._avg.amount;
    return average === null || average === undefined ? null : Number(average.toString());
  }
}
