import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { UserRole } from '@prisma/client';
import { SCOPES_KEY } from '../decorators/scopes.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { ForbiddenException, UnauthorizedException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';

/**
 * Checks whether a granted permission scope matches a required scope.
 * Supports exact match (`'transactions:write'`), resource wildcards (`'transactions:*'`),
 * and global wildcards (`'*'`, `'admin'`).
 */
export function matchScope(grantedScope: string, requiredScope: string): boolean {
  if (grantedScope === '*' || grantedScope === 'admin' || grantedScope === requiredScope) {
    return true;
  }

  const [grantedResource, grantedAction] = grantedScope.split(':');
  const [requiredResource] = requiredScope.split(':');

  if (grantedAction === '*' && grantedResource === requiredResource) {
    return true;
  }

  return false;
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

    const requiredScopes = this.reflector.getAllAndOverride<string[] | undefined>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredScopes || requiredScopes.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<
      Request & {
        user?: AuthenticatedUser;
        apiKey?: { permissions?: string[] };
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
      ...(user.permissions ?? []),
      ...(request.apiKey?.permissions ?? []),
    ];

    const missingScopes = requiredScopes.filter(
      (required) => !grantedScopes.some((granted) => matchScope(granted, required)),
    );

    if (missingScopes.length > 0) {
      throw new ForbiddenException(
        `Insufficient API key permissions. Missing required scope(s): ${missingScopes.join(', ')}`,
      );
    }

    return true;
  }
}
