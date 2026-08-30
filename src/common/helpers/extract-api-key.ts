import { Request } from 'express';
import { API_KEY_HEADER } from '../constants/headers';

/** Extracts a raw API key from standard request headers. */
export function extractApiKeyFromRequest(req: Request): string | undefined {
  const rawHeader =
    req.headers[API_KEY_HEADER] ??
    req.headers[API_KEY_HEADER.toLowerCase()] ??
    req.headers['x-api-key'];

  if (typeof rawHeader === 'string' && rawHeader.trim().length > 0) {
    return rawHeader.trim();
  }

  if (Array.isArray(rawHeader) && rawHeader.length > 0) {
    return rawHeader[0].trim();
  }

  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const authHeader = authorization.trim();
    if (/^ApiKey\s+/i.test(authHeader)) {
      return authHeader.replace(/^ApiKey\s+/i, '').trim();
    }
    if (/^Bearer\s+ak_/i.test(authHeader)) {
      return authHeader.replace(/^Bearer\s+/i, '').trim();
    }
  }

  return undefined;
}
