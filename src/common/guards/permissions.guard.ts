import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { UserRole } from '@prisma/client';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { ForbiddenException, UnauthorizedException } from '../exceptions/domain.exception';

/**
 * Authorises a request by checking required fine-grained permissions or roles.
 * OWNER and ADMIN roles implicitly pass permission checks.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<string[] | undefined>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser; apiKey?: { permissions?: string[]; scopes?: string[] } }>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('Authentication required for this resource');
    }

    // OWNER and ADMIN roles bypass permission checks
    if (user.role === UserRole.OWNER || user.role === UserRole.ADMIN) {
      return true;
    }

    const userPermissions: string[] = [
      ...(user.permissions || []),
      ...(user.scopes || []),
      ...(request.apiKey?.permissions || []),
      ...(request.apiKey?.scopes || []),
    ];

    const hasAll = requiredPermissions.every((perm) => {
      return userPermissions.includes('*') || userPermissions.includes(perm) || userPermissions.some((p) => {
        if (p.endsWith(':*')) {
          const resource = p.split(':')[0];
          return perm.startsWith(`${resource}:`);
        }
        return false;
      });
    });

    if (!hasAll) {
      throw new ForbiddenException(
        `Missing required permissions. Requires: ${requiredPermissions.join(', ')}`,
      );
    }

    return true;
  }
}
