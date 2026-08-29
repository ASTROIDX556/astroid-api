import { describe, expect, it, vi, beforeEach } from 'vitest';
import { IpWhitelistGuard } from '../guards/ip-whitelist.guard';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

describe('IpWhitelistGuard', () => {
  let guard: IpWhitelistGuard;
  let configService: ConfigService;

  beforeEach(() => {
    configService = {
      get: vi.fn(),
    } as unknown as ConfigService;
    guard = new IpWhitelistGuard(configService);
  });

  const createMockContext = (ip: string, apiKey: { allowedIps?: string[] } | null, forwardedFor?: string): ExecutionContext => {
    const request = {
      ip,
      headers: { 'x-forwarded-for': forwardedFor },
      apiKey,
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  };

  it('allows requests when no API key is present', () => {
    const context = createMockContext('192.168.1.1', null);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows requests when API key has no IP restrictions', () => {
    const context = createMockContext('192.168.1.1', { allowedIps: [] });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows requests when API key allowedIps is undefined', () => {
    const context = createMockContext('192.168.1.1', { allowedIps: undefined });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows requests when IP is within allowed CIDR range', () => {
    vi.mocked(configService.get).mockReturnValue(false);
    const context = createMockContext('192.168.1.100', { allowedIps: ['192.168.1.0/24'] });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows requests when IP matches exact CIDR /32', () => {
    vi.mocked(configService.get).mockReturnValue(false);
    const context = createMockContext('10.0.0.5', { allowedIps: ['10.0.0.5/32'] });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows requests when IP is within allowed IPv6 CIDR range', () => {
    vi.mocked(configService.get).mockReturnValue(false);
    const context = createMockContext('2001:db8::1', { allowedIps: ['2001:db8::/32'] });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows requests when IP matches any of multiple CIDR ranges', () => {
    vi.mocked(configService.get).mockReturnValue(false);
    const context = createMockContext('10.0.0.5', {
      allowedIps: ['192.168.1.0/24', '10.0.0.0/24', '172.16.0.0/24'],
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('blocks requests when IP is outside allowed CIDR range', () => {
    vi.mocked(configService.get).mockReturnValue(false);
    const context = createMockContext('192.168.2.1', { allowedIps: ['192.168.1.0/24'] });
    expect(() => guard.canActivate(context)).toThrow('IP address 192.168.2.1 is not authorized for this API key');
  });

  it('blocks requests when IP is not in any of the allowed ranges', () => {
    vi.mocked(configService.get).mockReturnValue(false);
    const context = createMockContext('8.8.8.8', {
      allowedIps: ['192.168.1.0/24', '10.0.0.0/24'],
    });
    expect(() => guard.canActivate(context)).toThrow('IP address 8.8.8.8 is not authorized for this API key');
  });

  it('uses x-forwarded-for header when trustProxy is enabled', () => {
    vi.mocked(configService.get).mockReturnValue(true);
    const context = createMockContext('192.168.1.1', { allowedIps: ['10.0.0.0/24'] }, '10.0.0.5, 192.168.1.1');
    expect(guard.canActivate(context)).toBe(true);
  });

  it('uses first IP from x-forwarded-for when trustProxy is enabled', () => {
    vi.mocked(configService.get).mockReturnValue(true);
    const context = createMockContext('192.168.1.1', { allowedIps: ['10.0.0.0/24'] }, '10.0.0.5, 10.0.0.6, 10.0.0.7');
    expect(guard.canActivate(context)).toBe(true);
  });

  it('ignores x-forwarded-for header when trustProxy is disabled', () => {
    vi.mocked(configService.get).mockReturnValue(false);
    const context = createMockContext('192.168.1.1', { allowedIps: ['192.168.1.0/24'] }, '10.0.0.5');
    expect(guard.canActivate(context)).toBe(true);
  });

  it('blocks request when forwarded IP is not in whitelist with trustProxy enabled', () => {
    vi.mocked(configService.get).mockReturnValue(true);
    const context = createMockContext('192.168.1.1', { allowedIps: ['10.0.0.0/24'] }, '8.8.8.8');
    expect(() => guard.canActivate(context)).toThrow('IP address 8.8.8.8 is not authorized for this API key');
  });

  it('allows localhost IP in development CIDR', () => {
    vi.mocked(configService.get).mockReturnValue(false);
    const context = createMockContext('127.0.0.1', { allowedIps: ['127.0.0.0/8'] });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('handles IPv6 loopback address', () => {
    vi.mocked(configService.get).mockReturnValue(false);
    const context = createMockContext('::1', { allowedIps: ['::1/128'] });
    expect(guard.canActivate(context)).toBe(true);
  });
});
