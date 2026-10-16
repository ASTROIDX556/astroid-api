import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP, LookupFunction } from 'node:net';

export interface ResolvedDestinationAddress {
  address: string;
  family: 4 | 6;
}

export type DestinationResolver = (
  hostname: string,
) => Promise<ResolvedDestinationAddress[]>;

export class WebhookDestinationError extends Error {
  constructor(message = 'Webhook destination is not allowed') {
    super(message);
    this.name = 'WebhookDestinationError';
  }
}

export class WebhookDestinationResolutionError extends Error {
  constructor() {
    super('Webhook hostname could not be resolved');
    this.name = 'WebhookDestinationResolutionError';
  }
}

const IPV4_BLOCKED_RANGES: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => (value << 8) | Number(part), 0) >>> 0;
}

function isBlockedIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  if (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) return true;
  if (octets[0] === 255 && octets[1] === 255 && octets[2] === 255 && octets[3] === 255) return true;

  const value = ipv4Number(address);
  return IPV4_BLOCKED_RANGES.some(([network, prefix]) => {
    const shift = 32 - prefix;
    const rangeStart = ipv4Number(network);
    return (value >>> shift) === (rangeStart >>> shift);
  });
}

function ipv6Number(address: string): bigint | undefined {
  let normalized = address.toLowerCase();
  const ipv4Tail = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Tail) {
    if (isIP(ipv4Tail[1]) !== 4) return undefined;
    const value = ipv4Number(ipv4Tail[1]);
    normalized = normalized.replace(ipv4Tail[1], `${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`);
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function isBlockedIpv6(address: string): boolean {
  const value = ipv6Number(address);
  if (value === undefined) return true;
  const prefix = (bits: number, length: number) => value >> BigInt(128 - length) === BigInt(bits);
  const isGlobalUnicast = prefix(0b001, 3);
  const isDocumentation = prefix(0x20010db8, 32);
  const isNewDocumentation = prefix(0x3fff0, 20);
  const isSpecial2001 = prefix(0x20010000, 23);
  const is6to4 = prefix(0x2002, 16);
  return !isGlobalUnicast || isDocumentation || isNewDocumentation || isSpecial2001 || is6to4;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isBlockedIpv4(address);
  if (family === 6) return !isBlockedIpv6(address);
  return false;
}

function validateUrlSyntax(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookDestinationError('Webhook URL must be a valid public HTTPS URL');
  }

  if (url.protocol !== 'https:') {
    throw new WebhookDestinationError('Webhook URL must use HTTPS');
  }
  if (url.username || url.password) {
    throw new WebhookDestinationError('Webhook URL must not contain credentials');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const family = isIP(hostname);
  if (!hostname || hostname.length > 253) {
    throw new WebhookDestinationError('Webhook URL must contain a valid hostname');
  }
  if (family) {
    if (!isPublicAddress(hostname)) {
      throw new WebhookDestinationError('Webhook destination must be a public IP address');
    }
  } else {
    const labels = hostname.split('.');
    if (
      labels.some((label) =>
        label.length === 0 || label.length > 63 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label),
      )
    ) {
      throw new WebhookDestinationError('Webhook URL must contain a valid hostname');
    }
    const normalized = hostname.toLowerCase();
    if (
      normalized === 'localhost' ||
      normalized.endsWith('.localhost') ||
      normalized.endsWith('.local') ||
      normalized.endsWith('.internal')
    ) {
      throw new WebhookDestinationError('Webhook destination must be a public hostname');
    }
    if (url.hostname.endsWith('.')) url.hostname = hostname;
  }
  return url;
}

export function validateWebhookUrlSyntax(value: string): void {
  validateUrlSyntax(value);
}

const resolveDestination: DestinationResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

/** Validates URL syntax and every DNS answer; returns vetted addresses for pinning the connection. */
export async function validateWebhookDestination(
  value: string,
  resolver: DestinationResolver = resolveDestination,
): Promise<{ url: URL; addresses: ResolvedDestinationAddress[] }> {
  const url = validateUrlSyntax(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(hostname)) return { url, addresses: [{ address: hostname, family: isIP(hostname) as 4 | 6 }] };

  let addresses: ResolvedDestinationAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new WebhookDestinationResolutionError();
  }
  if (addresses.length === 0) throw new WebhookDestinationResolutionError();
  if (addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new WebhookDestinationError('Webhook destination must resolve only to public IP addresses');
  }
  addresses.sort((left, right) => left.family - right.family);
  return { url, addresses };
}

export interface WebhookRequestOptions {
  headers: Record<string, string>;
  body: Buffer;
  timeoutMs: number;
}

export interface WebhookResponse {
  status: number;
}

export interface WebhookDestinationClient {
  post(url: string, options: WebhookRequestOptions): Promise<WebhookResponse>;
}

type PinnedTransport = (
  url: URL,
  addresses: ResolvedDestinationAddress[],
  options: WebhookRequestOptions,
) => Promise<WebhookResponse>;

function requestPinnedHttps(
  url: URL,
  addresses: ResolvedDestinationAddress[],
  options: WebhookRequestOptions,
): Promise<WebhookResponse> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + options.timeoutMs;
    let settled = false;
    const attemptAddress = (index: number): void => {
      const address = addresses[index];
      const remainingMs = deadline - Date.now();
      if (!address || remainingMs <= 0) {
        settled = true;
        reject(new Error('Webhook delivery request failed'));
        return;
      }

      const lookupPinned: LookupFunction = (_hostname, lookupOptions, callback) => {
        if (typeof lookupOptions === 'object' && lookupOptions.all) {
          callback(null, [address]);
        } else {
          callback(null, address.address, address.family);
        }
      };
      const request = httpsRequest(
        url,
        {
          method: 'POST',
          headers: options.headers,
          lookup: lookupPinned,
          agent: false,
          servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
        },
        (response) => {
          clearTimeout(timeout);
          response.resume();
          if (settled) return;
          settled = true;
          resolve({ status: response.statusCode ?? 0 });
        },
      );
      const timeout = setTimeout(() => request.destroy(new Error('Webhook request timed out')), remainingMs);
      request.once('error', () => {
        clearTimeout(timeout);
        if (settled) return;
        if (index + 1 < addresses.length) {
          attemptAddress(index + 1);
        } else {
          settled = true;
          reject(new Error('Webhook delivery request failed'));
        }
      });
      request.end(options.body);
    };

    attemptAddress(0);
  });
}

/** Shared registration and delivery policy. Delivery uses only its vetted DNS answers. */
export class WebhookDestinationPolicy implements WebhookDestinationClient {
  constructor(
    private readonly resolver: DestinationResolver = resolveDestination,
    private readonly transport: PinnedTransport = requestPinnedHttps,
  ) {}

  validate(url: string) {
    return validateWebhookDestination(url, this.resolver);
  }

  async post(url: string, options: WebhookRequestOptions): Promise<WebhookResponse> {
    const destination = await this.validate(url);
    return this.transport(destination.url, destination.addresses, options);
  }
}