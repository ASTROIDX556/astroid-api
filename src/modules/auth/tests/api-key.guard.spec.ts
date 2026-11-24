import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard } from '../../../common/guards/api-key.guard';
import { UnauthorizedException } from '../../../common/exceptions/domain.exception';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new ApiKeyGuard(reflector);
  });

  const createMockContext = (): ExecutionContext => {
    return {
      getHandler: vi.fn(),
      getClass: vi.fn(),
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
        }),
      }),
    } as unknown as ExecutionContext;
  };

  it('bypasses authentication when route is marked with @Public()', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === IS_PUBLIC_KEY) return true;
      return undefined;
    });

    const context = createMockContext();
    expect(guard.canActivate(context)).toBe(true);
  });

  it('returns user when authentication succeeds in handleRequest', () => {
    const user = { id: 'key-1', organizationId: 'org-1' };
    expect(guard.handleRequest(null, user)).toEqual(user);
  });

  it('throws UnauthorizedException when user is missing in handleRequest', () => {
    expect(() => guard.handleRequest(null, null)).toThrow(UnauthorizedException);
    expect(() => guard.handleRequest(null, false)).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when error occurs in handleRequest', () => {
    expect(() => guard.handleRequest(new Error('Auth failed'), null)).toThrow(
      UnauthorizedException,
    );
  });
});
