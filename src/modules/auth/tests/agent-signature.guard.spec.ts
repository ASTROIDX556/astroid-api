import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AgentSignatureGuard } from '../guards/agent-signature.guard';
import { Keypair } from '@stellar/stellar-sdk';
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('AgentSignatureGuard', () => {
  let guard: AgentSignatureGuard;

  beforeEach(() => {
    guard = new AgentSignatureGuard();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000000000000)); // fixed time
  });

  const createMockContext = (headers: Record<string, string>, body: Record<string, unknown> = {}): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
          body,
        }),
      }),
    } as unknown as ExecutionContext;
  };

  it('should throw UnauthorizedException if headers are missing', () => {
    const context = createMockContext({});
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Missing required agent signature headers');
  });

  it('should throw UnauthorizedException if timestamp is invalid', () => {
    const context = createMockContext({
      'x-agent-signature': 'sig',
      'x-agent-publickey': 'pub',
      'x-agent-timestamp': 'invalid',
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Invalid timestamp format');
  });

  it('should throw UnauthorizedException if timestamp is outside 5 minute window', () => {
    const context = createMockContext({
      'x-agent-signature': 'sig',
      'x-agent-publickey': 'pub',
      'x-agent-timestamp': (1000000000000 - 6 * 60 * 1000).toString(), // 6 minutes ago
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Timestamp out of valid window (possible replay attack)');
  });

  it('should throw UnauthorizedException if signature is invalid', () => {
    const keypair = Keypair.random();
    const timestamp = '1000000000000';
    const context = createMockContext({
      'x-agent-signature': 'invalid_base64_sig',
      'x-agent-publickey': keypair.publicKey(),
      'x-agent-timestamp': timestamp,
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Malformed signature or public key');
  });

  it('should return true and attach agent to request on valid signature', () => {
    const keypair = Keypair.random();
    const timestamp = '1000000000000';
    const body = { action: 'test' };
    const rawBody = JSON.stringify(body);
    const messageToVerify = `${timestamp}.${rawBody}`;
    const signature = keypair.sign(Buffer.from(messageToVerify)).toString('base64');

    const req = {
      headers: {
        'x-agent-signature': signature,
        'x-agent-publickey': keypair.publicKey(),
        'x-agent-timestamp': timestamp,
      },
      body,
    } as Record<string, unknown>;

    const context = {
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    } as unknown as ExecutionContext;

    const result = guard.canActivate(context);
    expect(result).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((req as any).agent).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((req as any).agent.publicKey).toBe(keypair.publicKey());
  });
});
