import { describe, expect, it } from 'vitest';

import {
  API_KEY_SCOPE_TIER_RULES,
  matchApiKeyScopeTier,
  resolveApiKeyScopeTier,
  TIER_RESTRICTIVENESS,
} from './api-key-scope-tier';

describe('API key scope → rate-limit tier mapping', () => {
  describe('matchApiKeyScopeTier', () => {
    it('maps credential-management scopes onto the auth tier', () => {
      expect(matchApiKeyScopeTier('auth:write')).toBe('auth');
      expect(matchApiKeyScopeTier('sessions:read')).toBe('auth');
      expect(matchApiKeyScopeTier('apikeys:write')).toBe('auth');
      expect(matchApiKeyScopeTier('credentials:rotate')).toBe('auth');
      expect(matchApiKeyScopeTier('tokens:revoke')).toBe('auth');
    });

    it('maps webhook management scopes onto the webhook tier', () => {
      expect(matchApiKeyScopeTier('webhooks:write')).toBe('webhook');
      expect(matchApiKeyScopeTier('webhook:read')).toBe('webhook');
    });

    it('maps agent control scopes onto the agent tier', () => {
      expect(matchApiKeyScopeTier('agents:execute')).toBe('agent');
      expect(matchApiKeyScopeTier('agent:read')).toBe('agent');
      expect(matchApiKeyScopeTier('transactions:execute')).toBe('agent');
    });

    it('leaves ordinary read-only scopes unconstrained', () => {
      expect(matchApiKeyScopeTier('transactions:read')).toBeUndefined();
      expect(matchApiKeyScopeTier('wallets:read')).toBeUndefined();
      expect(matchApiKeyScopeTier('organizations:read')).toBeUndefined();
    });

    it('treats wildcard grants as unconstrained', () => {
      expect(matchApiKeyScopeTier('*')).toBeUndefined();
      expect(matchApiKeyScopeTier('admin')).toBeUndefined();
      expect(matchApiKeyScopeTier('')).toBeUndefined();
      expect(matchApiKeyScopeTier('   ')).toBeUndefined();
    });

    it('matches resources case-insensitively and through wildcards', () => {
      expect(matchApiKeyScopeTier('Agents:Execute')).toBe('agent');
      expect(matchApiKeyScopeTier('agents:*')).toBe('agent');
      expect(matchApiKeyScopeTier('WEBHOOKS:write')).toBe('webhook');
    });

    it('ignores non-string scopes', () => {
      expect(matchApiKeyScopeTier(undefined as unknown as string)).toBeUndefined();
      expect(matchApiKeyScopeTier(42 as unknown as string)).toBeUndefined();
    });
  });

  describe('resolveApiKeyScopeTier', () => {
    it('returns undefined when no scope maps to a tier', () => {
      expect(resolveApiKeyScopeTier(['transactions:read', 'wallets:read'])).toBeUndefined();
    });

    it('returns undefined for an empty or missing scope list', () => {
      expect(resolveApiKeyScopeTier([])).toBeUndefined();
      expect(resolveApiKeyScopeTier(undefined)).toBeUndefined();
      expect(resolveApiKeyScopeTier(null)).toBeUndefined();
    });

    it('resolves a single matching scope to its tier', () => {
      expect(resolveApiKeyScopeTier(['webhooks:write'])).toBe('webhook');
    });

    it('keeps the most restrictive tier when several scopes match', () => {
      expect(resolveApiKeyScopeTier(['agents:execute', 'webhooks:write'])).toBe('webhook');
      expect(resolveApiKeyScopeTier(['agents:execute', 'auth:write'])).toBe('auth');
      expect(resolveApiKeyScopeTier(['webhooks:write', 'auth:write'])).toBe('auth');
    });

    it('ignores scopes that match no rule when another scope does', () => {
      expect(resolveApiKeyScopeTier(['transactions:read', 'auth:write'])).toBe('auth');
    });
  });

  describe('rule table', () => {
    it('keeps the auth tier the most restrictive one', () => {
      expect(TIER_RESTRICTIVENESS.auth).toBeGreaterThan(TIER_RESTRICTIVENESS.webhook);
      expect(TIER_RESTRICTIVENESS.webhook).toBeGreaterThan(TIER_RESTRICTIVENESS.agent);
      expect(TIER_RESTRICTIVENESS.agent).toBeGreaterThan(TIER_RESTRICTIVENESS.api);
    });

    it('declares a tier for every rule and only known tiers', () => {
      const knownTiers = Object.keys(TIER_RESTRICTIVENESS);
      for (const rule of API_KEY_SCOPE_TIER_RULES) {
        expect(knownTiers).toContain(rule.tier);
        expect(rule.resources.length + (rule.scopes?.length ?? 0)).toBeGreaterThan(0);
      }
    });
  });
});
