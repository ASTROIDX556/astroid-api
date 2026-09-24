import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnectionHealthIndicator } from './database-connection.health';
import { PrismaService } from '../../../database/prisma.service';

describe('DatabaseConnectionHealthIndicator', () => {
  let prisma: { $queryRaw: ReturnType<typeof vi.fn> };
  let indicator: DatabaseConnectionHealthIndicator;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = {
      $queryRaw: vi.fn(),
    };
    indicator = new DatabaseConnectionHealthIndicator(prisma as unknown as PrismaService);
  });

  it('returns up status when database query succeeds', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const report = await indicator.checkHealth();

    expect(report.status).toBe('up');
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.timestamp).toBeDefined();
    expect(report.error).toBeUndefined();
  });

  it('returns down status when database query throws an error', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('Connection refused'));

    const report = await indicator.checkHealth();

    expect(report.status).toBe('down');
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.timestamp).toBeDefined();
    expect(report.error).toBe('Connection refused');
  });
});
