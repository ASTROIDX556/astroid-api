import { describe, expect, it, vi } from 'vitest';
import {
  isPublicAddress,
  validateWebhookDestination,
  WebhookDestinationError,
  WebhookDestinationResolutionError,
} from './webhook-destination.policy';

describe('webhook destination policy', () => {
  it.each([
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.16.0.1', false],
    ['192.168.1.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['192.0.2.1', false],
    ['198.18.0.1', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
    ['::', false],
    ['::1', false],
    ['::ffff:127.0.0.1', false],
    ['fc00::1', false],
    ['fe80::1', false],
    ['ff02::1', false],
    ['2001:db8::1', false],
    ['3fff::1', false],
    ['8.8.8.8', true],
    ['2606:4700:4700::1111', true],
  ])('classifies %s as public=%s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it.each([
    'http://example.com/hook',
    'https://user:pass@example.com/hook',
    'https://127.0.0.1/hook',
    'https://[::1]/hook',
    'https://bad..example/hook',
    'not a url',
  ])('rejects disallowed URL %s', async (url) => {
    await expect(validateWebhookDestination(url)).rejects.toBeInstanceOf(WebhookDestinationError);
  });

  it('validates every DNS answer and hides resolver details', async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.4', family: 4 },
    ]);

    await expect(validateWebhookDestination('https://ExAmPlE.com./hook', resolver)).rejects.toThrow(
      'Webhook destination must resolve only to public IP addresses',
    );
    expect(resolver).toHaveBeenCalledWith('example.com');
  });

  it('accepts a public HTTPS hostname and retains validated addresses', async () => {
    const resolver = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const result = await validateWebhookDestination('https://example.com/hook', resolver);

    expect(result.url.hostname).toBe('example.com');
    expect(result.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('normalizes mixed-case hostnames and trailing dots for delivery', async () => {
    const resolver = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const result = await validateWebhookDestination('https://ExAmPlE.com./hook', resolver);

    expect(result.url.hostname).toBe('example.com');
    expect(resolver).toHaveBeenCalledWith('example.com');
  });

  it('does not expose internal DNS errors', async () => {
    const resolver = vi.fn().mockRejectedValue(new Error('private resolver details'));
    await expect(validateWebhookDestination('https://example.com/hook', resolver)).rejects.toBeInstanceOf(
      WebhookDestinationResolutionError,
    );
  });

  it('revalidates DNS during delivery after a public registration answer changes', async () => {
    const resolver = vi
      .fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    const transport = vi.fn().mockResolvedValue({ status: 200 });
    const { WebhookDestinationPolicy } = await import('./webhook-destination.policy');
    const policy = new WebhookDestinationPolicy(resolver, transport);

    await policy.validate('https://example.com/hook');
    await expect(
      policy.post('https://example.com/hook', {
        headers: {},
        body: Buffer.from('{}'),
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow('Webhook destination must resolve only to public IP addresses');
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(transport).not.toHaveBeenCalled();
  });
});