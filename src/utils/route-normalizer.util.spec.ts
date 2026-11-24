import { describe, expect, it } from 'vitest';
import { normalizeRoutePath } from './route-normalizer.util';

describe('normalizeRoutePath', () => {
  it('replaces UUID segments with :id', () => {
    expect(normalizeRoutePath('/v1/agents/550e8400-e29b-41d4-a716-446655440000')).toBe(
      '/v1/agents/:id',
    );
  });

  it('replaces numeric segments with :id', () => {
    expect(normalizeRoutePath('/v1/transactions/12345')).toBe('/v1/transactions/:id');
  });

  it('replaces opaque long id-like segments with :id', () => {
    expect(normalizeRoutePath('/v1/wallets/wal_9f8c7d6e5b4a3c2d1e0f')).toBe('/v1/wallets/:id');
  });

  it('leaves short, human-readable segments untouched', () => {
    expect(normalizeRoutePath('/v1/agents/export')).toBe('/v1/agents/export');
  });

  it('strips the query string', () => {
    expect(normalizeRoutePath('/v1/audit?page=1&limit=20')).toBe('/v1/audit');
  });

  it('returns / for the root path', () => {
    expect(normalizeRoutePath('/')).toBe('/');
  });

  it('preserves multiple identifier segments independently', () => {
    expect(normalizeRoutePath('/v1/organizations/42/agents/99')).toBe(
      '/v1/organizations/:id/agents/:id',
    );
  });
});
