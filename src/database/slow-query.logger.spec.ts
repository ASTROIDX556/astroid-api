import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  createSlowQueryMiddleware,
  sanitizeQueryArgs,
  analyzeIndexSuggestions,
  SlowQueryReport,
} from './slow-query.logger';

describe('Slow Query Logger & Index Analyzer', () => {
  describe('sanitizeQueryArgs', () => {
    it('redacts sensitive fields like passwords, secrets, tokens, and private keys', () => {
      const input = {
        where: {
          email: 'agent@stellar.org',
          passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$secretpass',
          apiSecret: 'sk_live_123456789',
          sessionToken: 'jwt-token-value',
          wallet: {
            publicKey: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXY',
            privateKey: 'SBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXY',
          },
        },
        data: {
          status: 'ACTIVE',
          authSignature: '0x123abc',
        },
      };

      const sanitized = sanitizeQueryArgs(input) as any;

      expect(sanitized.where.email).toBe('agent@stellar.org');
      expect(sanitized.where.passwordHash).toBe('[REDACTED]');
      expect(sanitized.where.apiSecret).toBe('[REDACTED]');
      expect(sanitized.where.sessionToken).toBe('[REDACTED]');
      expect(sanitized.where.wallet.publicKey).toBe('GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXY');
      expect(sanitized.where.wallet.privateKey).toBe('[REDACTED]');
      expect(sanitized.data.status).toBe('ACTIVE');
      expect(sanitized.data.authSignature).toBe('[REDACTED]');
    });

    it('handles arrays and primitives safely', () => {
      expect(sanitizeQueryArgs(null)).toBeNull();
      expect(sanitizeQueryArgs(undefined)).toBeUndefined();
      expect(sanitizeQueryArgs(42)).toBe(42);
      expect(sanitizeQueryArgs(true)).toBe(true);

      const arrayInput = [
        { id: 1, secretKey: 'top-secret' },
        { id: 2, secretKey: 'another-secret' },
      ];
      const sanitizedArray = sanitizeQueryArgs(arrayInput) as any[];
      expect(sanitizedArray[0].id).toBe(1);
      expect(sanitizedArray[0].secretKey).toBe('[REDACTED]');
      expect(sanitizedArray[1].id).toBe(2);
      expect(sanitizedArray[1].secretKey).toBe('[REDACTED]');
    });
  });

  describe('analyzeIndexSuggestions', () => {
    it('suggests composite indexes when filtering by multiple columns', () => {
      const suggestions = analyzeIndexSuggestions('Transaction', 'findMany', {
        where: {
          walletAddress: 'GBRP...',
          status: 'PENDING',
          assetCode: 'USDC',
        },
      });

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0]).toContain("Consider a composite index on model 'Transaction' for fields: [walletAddress, status, assetCode]");
    });

    it('suggests compound index when filtering and sorting', () => {
      const suggestions = analyzeIndexSuggestions('AuditLog', 'findMany', {
        where: {
          agentId: 'agent-123',
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      expect(suggestions.some((s) => s.includes('Consider compound index'))).toBe(true);
    });

    it('suggests pagination when unbounded findMany is executed', () => {
      const suggestions = analyzeIndexSuggestions('Agent', 'findMany', {
        where: { status: 'ACTIVE' },
      });

      expect(suggestions.some((s) => s.includes('Unbounded findMany'))).toBe(true);
    });
  });

  describe('createSlowQueryMiddleware', () => {
    let mockLogger: Logger;

    beforeEach(() => {
      mockLogger = {
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn(),
      } as unknown as Logger;
    });

    it('does not emit warning when query executes faster than threshold', async () => {
      const middleware = createSlowQueryMiddleware({
        thresholdMs: 100,
        logger: mockLogger,
      });

      const next = vi.fn().mockImplementation(async () => {
        // Fast execution
        return [{ id: 1 }];
      });

      const result = await middleware(
        {
          model: 'User',
          action: 'findUnique',
          args: { where: { id: 1 } },
          dataPath: [],
          runInTransaction: false,
        },
        next,
      );

      expect(result).toEqual([{ id: 1 }]);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('emits structured warning when query execution exceeds threshold', async () => {
      let reported: SlowQueryReport | null = null;

      const middleware = createSlowQueryMiddleware({
        thresholdMs: 50,
        logger: mockLogger,
        onSlowQuery: (report) => {
          reported = report;
        },
      });

      const next = vi.fn().mockImplementation(async () => {
        // Artificial delay exceeding 50ms
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { id: 'agent-123', name: 'StellarBot' };
      });

      const result = await middleware(
        {
          model: 'Agent',
          action: 'findMany',
          args: {
            where: {
              status: 'ACTIVE',
              apiKeySecret: 'secret_key_12345',
            },
          },
          dataPath: [],
          runInTransaction: false,
        },
        next,
      );

      expect(result).toEqual({ id: 'agent-123', name: 'StellarBot' });
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(reported).not.toBeNull();
      expect(reported?.model).toBe('Agent');
      expect(reported?.action).toBe('findMany');
      expect(reported?.durationMs).toBeGreaterThanOrEqual(50);
      expect(reported?.args?.where).toEqual({
        status: 'ACTIVE',
        apiKeySecret: '[REDACTED]',
      });
      expect(reported?.indexRecommendations?.length).toBeGreaterThan(0);
    });

    it('does not log when disabled', async () => {
      const middleware = createSlowQueryMiddleware({
        thresholdMs: 10,
        enabled: false,
        logger: mockLogger,
      });

      const next = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return true;
      });

      const result = await middleware(
        {
          model: 'Wallet',
          action: 'findFirst',
          args: {},
          dataPath: [],
          runInTransaction: false,
        },
        next,
      );

      expect(result).toBe(true);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('propagates errors while still capturing timing on slow failed queries', async () => {
      const middleware = createSlowQueryMiddleware({
        thresholdMs: 30,
        logger: mockLogger,
      });

      const next = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        throw new Error('Database connection timeout');
      });

      await expect(
        middleware(
          {
            model: 'Transaction',
            action: 'create',
            args: { data: { amount: 100 } },
            dataPath: [],
            runInTransaction: false,
          },
          next,
        ),
      ).rejects.toThrow('Database connection timeout');

      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });
});
