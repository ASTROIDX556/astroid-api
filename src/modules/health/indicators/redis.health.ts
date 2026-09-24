import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  private redisClient: Redis | null = null;

  constructor(private readonly configService: ConfigService) {}

  private getClient(): Redis {
    if (!this.redisClient) {
      try {
        const redisUrl = this.configService.get<string>('REDIS_URL') || process.env.REDIS_URL || 'redis://localhost:6379';
        this.redisClient = new Redis(redisUrl, {
          lazyConnect: true,
          enableReadyCheck: true,
          maxRetriesPerRequest: 1,
        });
      } catch (err) {
        this.logger.warn(`Failed to initialize Redis client for health check: ${err}`);
      }
    }
    if (!this.redisClient) {
      throw new Error('Redis client could not be initialized');
    }
    return this.redisClient;
  }

  async checkHealth(): Promise<RedisHealthReport> {
    const start = Date.now();
    try {
      const client = this.getClient();
      const res = await client.ping();
      const latencyMs = Date.now() - start;

      if (res !== 'PONG') {
        throw new Error(`Unexpected ping response: ${res}`);
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
