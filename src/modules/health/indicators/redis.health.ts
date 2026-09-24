import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { redisConfig } from '../../../config/redis.config';

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

  constructor(private readonly configService: ConfigService) {
    void this.configService;
  }

  private getClient(): Redis {
    if (!this.redisClient) {
      const { host, port, password, db } = redisConfig();
      this.redisClient = new Redis({
        host,
        port,
        password: password || undefined,
        db,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
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
      const pong = await client.ping();
      const latencyMs = Date.now() - start;

      if (pong === 'PONG') {
        return {
          status: 'up',
          timestamp: new Date().toISOString(),
          latencyMs,
        };
      }

      return {
        status: 'down',
        timestamp: new Date().toISOString(),
        latencyMs,
        error: `Unexpected ping response: ${pong}`,
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
