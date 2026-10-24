import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/decorators/api-error-responses.decorator';
import { ApiEnvelope } from '../../common/decorators/api-envelope.decorator';
import { Request } from 'express';
import { AuthService } from './auth.service';
import {
  loginSchema,
  LoginInput,
  LoginDto,
  RegisterDto,
  registerSchema,
  RegisterInput,
  RefreshDto,
  refreshSchema,
  RefreshInput,
  TokenPairDto,
  AuthResultDto,
  CurrentUserDto,
  LogoutResultDto,
} from './auth.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ThrottleTierDecorator } from '../../common/decorators/throttle-tier.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { UnauthorizedException } from '../../common/exceptions/domain.exception';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ────────────────────────────────────────────
  // Public endpoints (no auth required)
  // ────────────────────────────────────────────

  @Public()
  @Post('register')
  @ThrottleTierDecorator('auth')
  @ApiOperation({
    summary: 'Register a new organization and its owner',
    description:
      'Creates a new organization with the caller as the owner. Returns a JWT token pair.',
  })
  @ApiBody({ type: RegisterDto })
  @ApiEnvelope(AuthResultDto, {
    status: 201,
    description: 'Organization and owner created successfully',
  })
  @ApiErrorResponses({
    validation: 'Validation error (missing or invalid fields)',
    conflict: 'Email address already registered',
    tooManyRequests: true,
    serverError: true,
  })
  register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @Req() req: Request,
  ) {
    return this.authService.register(body, this.sessionContext(req));
  }

  @Public()
  @Post('login')
  @ThrottleTierDecorator('auth')
  @ApiOperation({
    summary: 'Authenticate with email and password',
    description: 'Validates credentials and returns a JWT access/refresh token pair.',
  })
  @ApiBody({ type: LoginDto })
  @ApiEnvelope(AuthResultDto, { description: 'Authenticated successfully' })
  @ApiErrorResponses({
    validation: true,
    unauthorized: 'Invalid email or password',
    tooManyRequests: true,
    serverError: true,
  })
  login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Req() req: Request,
  ) {
    return this.authService.login(body, this.sessionContext(req));
  }

  @Public()
  @Post('refresh')
  @ThrottleTierDecorator('auth')
  @ApiOperation({
    summary: 'Rotate an access/refresh token pair',
    description:
      'Exchanges a valid refresh token for a new access/refresh token pair. The old refresh token is invalidated.',
  })
  @ApiBody({ type: RefreshDto })
  @ApiEnvelope(TokenPairDto, { description: 'Token pair rotated successfully' })
  @ApiErrorResponses({
    validation: true,
    unauthorized: 'Invalid or expired refresh token',
    tooManyRequests: true,
    serverError: true,
  })
  refresh(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput) {
    return this.authService.refresh(body.refreshToken);
  }

  // ────────────────────────────────────────────
  // Authenticated endpoints
  // ────────────────────────────────────────────

  @Post('logout')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Revoke the current session',
    description: 'Invalidates the JWT session so the access/refresh token pair can no longer be used.',
  })
  @ApiEnvelope(LogoutResultDto, { description: 'Session revoked' })
  @ApiErrorResponses({
    unauthorized: 'Not authenticated or no active session on this token',
    serverError: true,
  })
  logout(@CurrentUser() user: AuthenticatedUser) {
    if (!user.sessionId) {
      throw new UnauthorizedException('No active session on this token');
    }
    return this.authService.logout(user.sessionId);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the current authenticated user',
    description: 'Returns the profile and organization details of the authenticated user.',
  })
  @ApiEnvelope(CurrentUserDto, { description: 'Current user profile' })
  @ApiErrorResponses({ unauthorized: true, serverError: true })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.me(user);
  }

  @Get('session')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the current session principal',
    description: 'PRD alias of GET /auth/me — resolves the authenticated user.',
  })
  @ApiEnvelope(CurrentUserDto, { description: 'Current session principal' })
  @ApiErrorResponses({ unauthorized: true, serverError: true })
  session(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.me(user);
  }

  // Passkey endpoints have moved to PasskeyController under /auth/passkey/*.
  // See src/modules/auth/controllers/passkey.controller.ts

  /** Extracts best-effort device metadata for session records. */
  private sessionContext(req: Request) {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      undefined;
    return {
      device: (req.headers['user-agent'] as string) ?? undefined,
      browser: (req.headers['user-agent'] as string) ?? undefined,
      ipAddress: ip,
    };
  }
}

// Re-export Swagger DTOs so they are picked up by the OpenAPI scanner.
export { LoginDto, RegisterDto, RefreshDto };
