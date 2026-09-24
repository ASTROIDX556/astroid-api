import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';

export interface RedisHealthReport {
  status: 'up' | 'down';
  timestamp: string;
  latencyMs: number;
  error?: string;
}

@Injectable()
export class RedisHealthIndicator {
  private readonly logger = new Logger(RedisHealthIndicator.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async checkHealth(): Promise<RedisHealthReport> {
    const start = Date.now();
    try {
      const res = await this.redis.ping();
      const latencyMs = Date.now() - start;
      if (res !== 'PONG') {
        return {
          status: 'down',
          timestamp: new Date().toISOString(),
          latencyMs,
          error: `Unexpected Redis ping response: ${res}`,
        };
      }
      return {
        status: 'up',
        timestamp: new Date().toISOString(),
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Redis health check failed: ${message}`);
      return {
        status: 'down',
        timestamp: new Date().toISOString(),
        latencyMs,
        error: message,
      };
    }
  }
}
