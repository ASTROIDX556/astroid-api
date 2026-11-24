import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('Transaction history database index coverage (#285)', () => {
  it('ensures Prisma Transaction model indexes organizationId, agentId, and createdAt', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    expect(schema).toContain('@@index([organizationId, createdAt])');
    expect(schema).toContain('@@index([agentId, createdAt])');
  });
});
