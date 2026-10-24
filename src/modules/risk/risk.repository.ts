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

/**
 * Repository for risk assessment persistence and historical analysis.
 * Stores risk evaluation results for compliance reporting and pattern detection.
 */
@Injectable()
export class RiskRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a risk assessment result for audit trail compliance.
   */
  async createAssessmentRecord(data: {
    organizationId: string;
    transactionId: string;
    score: number;
    band: RiskBand;
    factors: Record<string, unknown>;
    canAutoExecute: boolean;
  }) {
    const assessment = {
      organizationId: data.organizationId,
      transactionId: data.transactionId,
      score: data.score,
      band: data.band,
      factors: data.factors,
      canAutoExecute: data.canAutoExecute,
    };
    // Upsert makes retries of a risk-analysis job safe for the unique transactionId.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.prisma as any).riskAssessment.upsert({
      where: { transactionId: data.transactionId },
      create: assessment,
      update: {
        score: data.score,
        band: data.band,
        factors: data.factors,
        canAutoExecute: data.canAutoExecute,
      },
    });
  }

  async updateTransactionRisk(
    organizationId: string,
    transactionId: string,
    data: { score: number; band: RiskBand; requiresApproval: boolean },
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (this.prisma as any).workerClient ?? this.prisma;
    return client.transaction.updateMany({
      where: { id: transactionId, organizationId },
      data: {
        riskScore: data.score,
        riskBand: data.band,
        ...(data.requiresApproval ? { requiresApproval: true } : {}),
      },
    });
  }

  /** Require human approval and freeze the originating wallet on critical risk. */
  async enforceRiskControls(organizationId: string, transactionId: string, critical: boolean) {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, organizationId }, select: { walletId: true },
    });
    if (!tx) throw new Error('Transaction not found for risk controls');
    await this.prisma.$transaction(async (db) => {
      await db.transaction.update({
        where: { id: transactionId }, data: { requiresApproval: true },
      });
      if (critical) {
        await db.wallet.update({
          where: { id: tx.walletId }, data: { status: 'FROZEN' },
        });
      }
    });
  }

  /** Derive a 24-hour baseline from prior transactions for this wallet. */
  async getTransactionBaseline(organizationId: string, transactionId: string) {
    const current = await this.prisma.transaction.findFirst({
      where: { id: transactionId, organizationId },
      select: { walletId: true, recipientAddress: true, createdAt: true },
    });
    if (!current) throw new Error('Transaction not found for risk analysis');
    const since = new Date(current.createdAt.getTime() - 24 * 60 * 60 * 1000);
    const history = await this.prisma.transaction.findMany({
      where: {
        organizationId, walletId: current.walletId,
        id: { not: transactionId },
        createdAt: { gte: since, lt: current.createdAt },
      },
      select: { amount: true, recipientAddress: true },
      take: 1000,
    });
    const total = history.reduce((sum, item) => sum + Number(item.amount), 0);
    return {
      recentTransactionCount: history.length + 1,
      baselineTransactionCount: history.length,
      baselineAmount: history.length ? total / history.length : 0,
      knownRecipient: history.some((item) => item.recipientAddress === current.recipientAddress),
    };
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
}
