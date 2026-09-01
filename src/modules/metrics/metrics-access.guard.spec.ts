import { describe, expect, it, vi } from 'vitest';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsAccessGuard } from './metrics-access.guard';

function buildContext(ip: string, forwardedFor?: string): ExecutionContext {
  const req = {
    ip,
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    socket: { remoteAddress: ip },
  };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

function buildConfig(allowedIps: string[], trustProxy = false): ConfigService {
  return {
    getOrThrow: vi.fn(() => ({ allowedIps })),
    get: vi.fn(() => trustProxy),
  } as unknown as ConfigService;
}

describe('MetricsAccessGuard', () => {
  it('allows a request from an IP within the configured CIDR ranges', () => {
    const guard = new MetricsAccessGuard(buildConfig(['127.0.0.1/32']));
    expect(guard.canActivate(buildContext('127.0.0.1'))).toBe(true);
  });

  it('rejects a request from an IP outside the configured CIDR ranges', () => {
    const guard = new MetricsAccessGuard(buildConfig(['10.0.0.0/8']));
    expect(() => guard.canActivate(buildContext('203.0.113.5'))).toThrow(ForbiddenException);
  });

  it('allows every request when no CIDR ranges are configured', () => {
    const guard = new MetricsAccessGuard(buildConfig([]));
    expect(guard.canActivate(buildContext('203.0.113.5'))).toBe(true);
  });

  it('trusts x-forwarded-for only when trustProxy is enabled', () => {
    const guard = new MetricsAccessGuard(buildConfig(['10.0.0.0/8'], true));
    expect(guard.canActivate(buildContext('203.0.113.5', '10.1.2.3'))).toBe(true);
  });
});
