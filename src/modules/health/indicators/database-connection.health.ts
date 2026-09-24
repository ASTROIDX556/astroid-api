import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';

export interface HealthIndicatorResult {
  status: 'up' | 'down';
  latencyMs: number;
  timestamp: string;
  error?: string;
}

@Injectable()
export class DatabaseConnectionHealthIndicator {
  constructor(private readonly prisma: PrismaService) {}

  async checkHealth(): Promise<HealthIndicatorResult> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const latencyMs = Date.now() - start;
      return {
        status: 'up',
        latencyMs,
        timestamp: new Date().toISOString(),
      };
    } catch (error: unknown) {
      const latencyMs = Date.now() - start;
      const err = error as Error;
      return {
        status: 'down',
        latencyMs,
        timestamp: new Date().toISOString(),
        error: err.message,
      };
    }
  }
}
