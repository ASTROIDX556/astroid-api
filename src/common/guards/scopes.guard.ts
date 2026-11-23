import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { UserRole } from '@prisma/client';
import { SCOPES_KEY } from '../decorators/scopes.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { ForbiddenException, UnauthorizedException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';
import { API_KEY_SCOPES } from '../constants/scopes';
import type { ApiKeyScope } from '../constants/scopes';

/**
 * Checks an exact grant and rejects values outside the API-key scope vocabulary.
 */
export function matchScope(grantedScope: string, requiredScope: string): boolean {
  return API_KEY_SCOPES.some((scope) => scope === grantedScope) && grantedScope === requiredScope;
}

/**
 * Guard that verifies the requesting principal holds the fine-grained permission scopes
 * declared via `@RequireScopes(...)` / `@Scopes(...)`.
 */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredScopes = this.reflector.getAllAndOverride<ApiKeyScope[] | undefined>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredScopes || requiredScopes.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<
      Request & {
        user?: AuthenticatedUser;
        apiKey?: { scopes?: string[] };
      }
    >();

    const user = request.user;
    if (!user) {
      throw new UnauthorizedException(
        'Authentication required for this resource',
        ErrorCode.UNAUTHORIZED,
      );
    }

    // Full system owners or administrators authenticated via JWT satisfy all scopes
    if (!user.isApiKey && (user.role === UserRole.OWNER || user.role === UserRole.ADMIN)) {
      return true;
    }

    const grantedScopes = [
      ...(user.scopes ?? []),
      ...(request.apiKey?.scopes ?? []),
    ];

    const missingScopes = requiredScopes.filter(
      (required) => !grantedScopes.some((granted) => matchScope(granted, required)),
    );

    if (missingScopes.length > 0) {
      throw new ForbiddenException(
        `Insufficient API key permissions. Missing required scope(s): ${missingScopes.join(', ')}`,
        ErrorCode.FORBIDDEN,
      );
    }

    return true;
  }
}
