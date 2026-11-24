import { SetMetadata } from '@nestjs/common';
import type { ZodTypeAny } from 'zod';

export const IDEMPOTENT_KEY = 'idempotent_request';

export interface IdempotentOptions {
  /**
   * Body schema used by the interceptor to normalize the payload before it is
   * fingerprinted. Keep it in sync with the route-level Zod validation pipe.
   */
  bodySchema?: ZodTypeAny;
}

/**
 * Opts a create handler into idempotent request handling. The header name and
 * TTL are configured through the config module; requests without the header
 * bypass the mechanism entirely.
 */
export const Idempotent = (options: IdempotentOptions = {}) =>
  SetMetadata(IDEMPOTENT_KEY, options);
