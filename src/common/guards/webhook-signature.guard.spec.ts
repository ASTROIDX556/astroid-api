import { describe, expect, it, vi } from 'vitest';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { WebhookSignatureGuard } from './webhook-signature.guard';
import type { WebhookSecretResolver } from './webhook-signature.guard';
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from '../constants/headers';

describe('WebhookSignatureGuard', () => {
  const secret = 'test-webhook-secret';
  const config = {
    get: (key: string) => (key === 'WEBHOOK_INGRESS_SECRET' ? secret : undefined),
  } as unknown as ConfigService;
  const guard = new WebhookSignatureGuard(config);

  function context(
    timestamp: string,
    signature: string,
    rawBody: Buffer | undefined,
    integrationId?: string,
  ): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {
            [WEBHOOK_SIGNATURE_HEADER]: signature,
            [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
            ...(integrationId ? { 'x-integration-id': integrationId } : {}),
          },
          body: rawBody?.toString('utf8'),
          rawBody,
        }),
      }),
    } as unknown as ExecutionContext;
  }

  function signatureFor(key: string, timestamp: string, body: Buffer): string {
    return createHmac('sha256', key)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]))
      .digest('hex');
  }

  it('accepts a fresh signature over the exact raw request bytes', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const rawBody = Buffer.from('{ "event": "test", "data": {"a":1} }');
    const requestContext = context(timestamp, signatureFor(secret, timestamp, rawBody), rawBody);

    await expect(guard.canActivate(requestContext)).resolves.toBe(true);
  });

  it('accepts the versioned v1= signature format used for outbound deliveries', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const rawBody = Buffer.from('{"event":"test"}');
    const requestContext = context(timestamp, `v1=${signatureFor(secret, timestamp, rawBody)}`, rawBody);

    await expect(guard.canActivate(requestContext)).resolves.toBe(true);
  });

  it('rejects missing or malformed signatures and timestamps', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const rawBody = Buffer.from('{}');
    const valid = signatureFor(secret, timestamp, rawBody);

    await expect(guard.canActivate(context(timestamp, '', rawBody))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guard.canActivate(context(timestamp, 'not-a-signature', rawBody))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guard.canActivate(context('not-a-timestamp', valid, rawBody))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guard.canActivate(context(timestamp, valid, undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a modified body and an expired timestamp', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signedBody = Buffer.from('{"value":1}');
    const tamperedBody = Buffer.from('{"value":2}');
    const signature = signatureFor(secret, timestamp, signedBody);

    await expect(guard.canActivate(context(timestamp, signature, tamperedBody))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    const expired = (Number(timestamp) - 400).toString();
    await expect(
      guard.canActivate(context(expired, signatureFor(secret, expired, signedBody), signedBody)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects requests when no inbound secret is configured', async () => {
    const guardWithoutSecret = new WebhookSignatureGuard({ get: () => undefined } as unknown as ConfigService);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const rawBody = Buffer.from('{}');

    await expect(
      guardWithoutSecret.canActivate(
        context(timestamp, signatureFor(secret, timestamp, rawBody), rawBody),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('awaits an integration-specific secret resolver', async () => {
    const integrationSecret = 'integration-specific-secret';
    const resolver: WebhookSecretResolver = vi.fn().mockResolvedValue(integrationSecret);
    const guarded = new WebhookSignatureGuard(config, { secretResolver: resolver });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const rawBody = Buffer.from('{"event":"partner.callback"}');

    await expect(
      guarded.canActivate(
        context(timestamp, signatureFor(integrationSecret, timestamp, rawBody), rawBody, 'partner-1'),
      ),
    ).resolves.toBe(true);
    expect(resolver).toHaveBeenCalledWith(expect.any(Object), 'partner-1');
  });

  it('does not fall back to a global secret when an integration resolver cannot select one', async () => {
    const resolver: WebhookSecretResolver = vi.fn().mockResolvedValue(undefined);
    const guarded = new WebhookSignatureGuard(config, { secretResolver: resolver });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const rawBody = Buffer.from('{}');

    await expect(
      guarded.canActivate(context(timestamp, signatureFor(secret, timestamp, rawBody), rawBody)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
