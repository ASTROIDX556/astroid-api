import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import {
  ApiKeyScope,
  hasScopeGrant,
} from '../constants/api-key-scopes';
import { REQUIRED_SCOPES_KEY } from '../decorators/require-scopes.decorator';
import {
  ForbiddenException,
  UnauthorizedException,
} from '../exceptions/domain.exception';
import { AuthenticatedApiKey } from '../interfaces/authenticated-user.interface';

type RequestWithApiKey = Request & { apiKey?: AuthenticatedApiKey };

/**
 * Enforces API-key scopes on routes decorated with `@RequireScopes(...)`.
 *
 * The guard is transport-independent by design: it never parses credentials.
 * It reads the already-resolved principal from `request.apiKey`, which an
 * API-key authentication layer is responsible for attaching.
 *
 * Behaviour:
 *   - no `@RequireScopes` metadata            -> allowed
 *   - requests without `request.apiKey` (JWT) -> allowed (RBAC unchanged)
 *   - revoked or expired key                  -> 401
 *   - key lacking a required scope             -> 403
 *   - legacy key with an empty scope set       -> allowed (documented migration)
 */
@Injectable()
export class ApiKeyScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<ApiKeyScope[]>(REQUIRED_SCOPES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const request = context.switchToHttp().getRequest<RequestWithApiKey>();
    const apiKey = request.apiKey;

    // Not an API-key request (JWT session or unauthenticated): leave the
    // existing authentication/RBAC chain exactly as it was.
    if (!apiKey) {
      return true;
    }

    if (apiKey.revokedAt) {
      throw new UnauthorizedException('API key has been revoked');
    }
    if (apiKey.expiresAt && apiKey.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('API key has expired');
    }

    if (!hasScopeGrant(apiKey.scopes, required)) {
      const missing = required.filter((scope) => !apiKey.scopes.includes(scope));
      throw new ForbiddenException(
        `API key is missing required scope(s): ${missing.join(', ')}`,
      );
    }

    return true;
  }
}
