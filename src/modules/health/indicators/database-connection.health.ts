import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';

export interface DatabaseConnectionHealthReport {
  status: 'up' | 'down';
  latencyMs: number;
  timestamp: string;
  error?: string;
}

@Injectable()
export class DatabaseConnectionHealthIndicator {
  private readonly logger = new Logger(DatabaseConnectionHealthIndicator.name);
  private readonly timeoutMs = 3000;

  constructor(private readonly prisma: PrismaService) {}

  async checkHealth(): Promise<DatabaseConnectionHealthReport> {
    const start = Date.now();
    try {
      const queryPromise = this.prisma.$queryRaw`SELECT 1`;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Database query timed out')), this.timeoutMs),
      );

      await Promise.race([queryPromise, timeoutPromise]);
      const latencyMs = Date.now() - start;

      return {
        status: 'up',
        latencyMs,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(`Database health check failed: ${errorMessage}`);

      return {
        status: 'down',
        latencyMs,
        timestamp: new Date().toISOString(),
        error: errorMessage,
      };
    }
  }
}
