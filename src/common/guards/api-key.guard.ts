import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ErrorCode } from '../constants/error-codes';
import { UnauthorizedException } from '../exceptions/domain.exception';

/**
 * Guard enforcing API Key authentication ('api-key' passport strategy).
 * Bypassed when route or controller is marked `@Public()`.
 */
@Injectable()
export class ApiKeyGuard extends AuthGuard('api-key') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }

  handleRequest<TUser>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw new UnauthorizedException('Invalid or missing API key', ErrorCode.UNAUTHORIZED);
    }
    return user;
  }
}
