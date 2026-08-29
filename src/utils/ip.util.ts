/**
 * IP address utilities for CIDR validation and proxy header parsing.
 * Zero-dependency implementation using Node.js built-in modules.
 */

/**
 * Checks if an IP address is within a CIDR range.
 * Supports both IPv4 and IPv6 addresses and CIDR notations.
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const [network, prefixLength] = cidr.split('/');
  const prefix = parseInt(prefixLength, 10);

  if (ip.includes(':') && network.includes(':')) {
    return isIPv6InCidr(ip, network, prefix);
  }
  if (!ip.includes(':') && !network.includes(':')) {
    return isIPv4InCidr(ip, network, prefix);
  }
  return false;
}

function isIPv4InCidr(ip: string, network: string, prefix: number): boolean {
  const ipNum = ipv4ToNumber(ip);
  const networkNum = ipv4ToNumber(network);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (networkNum & mask);
}

function isIPv6InCidr(ip: string, network: string, prefix: number): boolean {
  const ipBytes = ipv6ToBytes(ip);
  const networkBytes = ipv6ToBytes(network);
  const fullBytes = Math.floor(prefix / 8);
  const partialBits = prefix % 8;

  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== networkBytes[i]) {
      return false;
    }
  }

  if (partialBits > 0 && fullBytes < 16) {
    const mask = (0xff << (8 - partialBits)) & 0xff;
    if ((ipBytes[fullBytes] & mask) !== (networkBytes[fullBytes] & mask)) {
      return false;
    }
  }

  return true;
}

function ipv4ToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  return (
    ((parts[0] << 24) |
      (parts[1] << 16) |
      (parts[2] << 8) |
      parts[3]) >>>
    0
  );
}

function ipv6ToBytes(ip: string): Uint8Array {
  const parts = ip.split(':');
  const bytes = new Uint8Array(16);
  let byteIndex = 0;

  for (const part of parts) {
    if (part === '') {
      const emptyCount = 8 - parts.length + 1;
      for (let i = 0; i < emptyCount; i++) {
        bytes[byteIndex++] = 0;
        bytes[byteIndex++] = 0;
      }
    } else {
      const num = parseInt(part, 16);
      bytes[byteIndex++] = (num >> 8) & 0xff;
      bytes[byteIndex++] = num & 0xff;
    }
  }

  return bytes;
}

/**
 * Extracts the client IP address from a request, respecting proxy headers.
 * Only trusts proxy headers if the app is configured to trust proxies.
 */
export function getClientIp(
  ip: string,
  forwardedFor?: string,
  trustProxy = false,
): string {
  if (trustProxy && forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  return ip;
}

/**
 * Validates if an IP address is in any of the provided CIDR ranges.
 * Returns true if the list is empty (allow-all fallback).
 */
export function isIpAllowed(ip: string, allowedIps: string[]): boolean {
  if (allowedIps.length === 0) {
    return true;
  }
  return allowedIps.some((cidr) => isIpInCidr(ip, cidr));
}
