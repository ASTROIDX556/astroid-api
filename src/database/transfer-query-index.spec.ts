import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  HIGH_FREQUENCY_TRANSFER_INDICES,
  matchesIndexedTransferQuery,
} from './transfer-query-index.helper';

describe('High-frequency transfer compound index coverage (#311)', () => {
  it('verifies compound transfer indices exist in Prisma schema and match query prefixes', () => {
    const schemaPath = join(process.cwd(), 'prisma/schema.prisma');
    const schema = readFileSync(schemaPath, 'utf8');
    expect(schema).toContain('@@index([organizationId, status, createdAt])');
    expect(schema).toContain('@@index([agentId, status, createdAt])');
    expect(HIGH_FREQUENCY_TRANSFER_INDICES).toHaveLength(2);
    expect(
      matchesIndexedTransferQuery(['organizationId', 'status', 'createdAt']),
    ).toBe(true);
    expect(matchesIndexedTransferQuery(['unindexedColumn'])).toBe(false);
  });
});
