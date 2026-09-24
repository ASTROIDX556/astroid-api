import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisConfig } from '../../../config/redis.config';

export interface RedisHealthReport {
  status: 'up' | 'down';
  latencyMs: number;
  timestamp: string;
  error?: string;
}

@Injectable()
export class RedisHealthIndicator {
  private readonly logger = new Logger(RedisHealthIndicator.name);
  private readonly timeoutMs = 3000;
  private redisClient: Redis | null = null;

  constructor(private readonly configService: ConfigService) {}

  private getClient(): Redis {
    if (!this.redisClient) {
      const config = this.configService.get<RedisConfig>('redis');
      this.redisClient = new Redis({
        host: config?.host ?? process.env.REDIS_HOST ?? 'localhost',
        port: config?.port ?? Number(process.env.REDIS_PORT ?? 6379),
        password: config?.password ?? process.env.REDIS_PASSWORD ?? undefined,
        db: config?.db ?? Number(process.env.REDIS_DB ?? 0),
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: this.timeoutMs,
      });
    }
    return this.redisClient;
  }

  async checkHealth(): Promise<RedisHealthReport> {
    const start = Date.now();
    try {
      const client = this.getClient();

      if (client.status === 'wait') {
        await client.connect();
      }

      const pingPromise = client.ping();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis ping timed out')), this.timeoutMs),
      );

      const result = await Promise.race([pingPromise, timeoutPromise]);
      if (result !== 'PONG') {
        throw new Error(`Unexpected Redis ping response: ${String(result)}`);
      }

      const latencyMs = Date.now() - start;
      return {
        status: 'up',
        latencyMs,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(`Redis health check failed: ${errorMessage}`);

      return {
        status: 'down',
        latencyMs,
        timestamp: new Date().toISOString(),
        error: errorMessage,
      };
    }
  }
}
