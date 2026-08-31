import { Body, Controller, Get, Post, Req, Delete, Param } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { Request } from 'express';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import { ThrottleTierDecorator } from '../../../common/decorators/throttle-tier.decorator';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { NotFoundException } from '../../../common/exceptions/domain.exception';
import {
  verifyPasskeyRegistrationSchema,
  VerifyPasskeyRegistrationInput,
  generateAuthenticationOptionsSchema,
  GenerateAuthenticationOptionsInput,
  verifyPasskeyAuthenticationSchema,
  VerifyPasskeyAuthenticationInput,
  PasskeyCredentialDto,
} from '../dto/passkey.dto';
import { PasskeyService } from '../services/passkey.service';
import { AuthService } from '../auth.service';

/**
 * WebAuthn passkey endpoints for both registration and authentication
 * ceremonies.
 *
 * Registration flow (authenticated user adding a passkey):
 *   1. POST /auth/passkey/register/options  → returns creation options + challenge
 *   2. Client completes the WebAuthn ceremony via @simplewebauthn/browser.
 *   3. POST /auth/passkey/register/verify   → verifies & persists the credential
 *
 * Login flow (passwordless authentication):
 *   1. POST /auth/passkey/login/options  (public, body: { email })
 *   2. Client completes the WebAuthn assertion ceremony.
 *   3. POST /auth/passkey/login/verify   (public) → issues a token pair
 */
@ApiTags('auth')
@Controller('auth/passkey')
export class PasskeyController {
  constructor(
    private readonly passkeyService: PasskeyService,
    private readonly authService: AuthService,
  ) {}

  /**
   * POST /auth/passkey/register/options
   *
   * Generates WebAuthn registration options for an authenticated user and
   * stores the challenge. Call this before `register/verify`.
   */
  @Post('register/options')
  @ApiBearerAuth('access-token')
  @ThrottleTierDecorator('auth')
  @ApiOperation({
    summary: 'Generate WebAuthn registration options for a passkey',
    description:
      'Returns the creation options (challenge, RP, user, excludeCredentials) ' +
      'to pass into navigator.credentials.create(). Stores the challenge for ' +
      'verification on the subsequent register/verify call.',
  })
  generateRegistrationOptions(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return this.passkeyService.generateRegistrationOptions(user.id);
  }

  /**
   * POST /auth/passkey/register/verify
   *
   * Consumes the registration challenge response credential, cryptographically
   * verifies it, invalidates the stored challenge, and persists the new passkey
   * credential atomically.
   */
  @Post('register/verify')
  @ApiBearerAuth('access-token')
  @ThrottleTierDecorator('auth')
  @ApiOperation({
    summary: 'Verify a WebAuthn registration challenge response',
    description:
      'Validates the attestation credential from @simplewebauthn/browser, ' +
      'persists the public key and credential ID, and invalidates the challenge.',
  })
  verifyRegistration(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(verifyPasskeyRegistrationSchema))
    body: VerifyPasskeyRegistrationInput,
    @Req() req: Request,
  ): Promise<PasskeyCredentialDto> {
    const userAgent = req.headers['user-agent'] as string | undefined;
    return this.passkeyService.verifyRegistration(user.id, body, userAgent);
  }

  /**
   * POST /auth/passkey/login/options
   *
   * Generates WebAuthn authentication options for a user identified by email.
   * Public — no bearer token required.
   */
  @Public()
  @Post('login/options')
  @ThrottleTierDecorator('auth')
  @ApiOperation({
    summary: 'Generate WebAuthn authentication options for a passkey login',
    description:
      'Given an email, returns the request options (challenge, allowCredentials) ' +
      'to pass into navigator.credentials.get(). The user must have at least one ' +
      'registered passkey.',
  })
  generateAuthenticationOptions(
    @Body(new ZodValidationPipe(generateAuthenticationOptionsSchema))
    body: GenerateAuthenticationOptionsInput,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return this.passkeyService.generateAuthenticationOptions(body.email);
  }

  /**
   * POST /auth/passkey/login/verify
   *
   * Verifies the WebAuthn assertion, updates the credential counter, and on
   * success issues a fresh access + refresh token pair.
   */
  @Public()
  @Post('login/verify')
  @ThrottleTierDecorator('auth')
  @ApiOperation({
    summary: 'Verify a WebAuthn authentication assertion and log in',
    description:
      'Validates the assertion credential from @simplewebauthn/browser, updates ' +
      'the signature counter, invalidates the challenge, and issues a token pair.',
  })
  async verifyAuthenticationAndLogin(
    @Body(new ZodValidationPipe(verifyPasskeyAuthenticationSchema))
    body: VerifyPasskeyAuthenticationInput,
    @Req() req: Request,
  ) {
    const userAgent = req.headers['user-agent'] as string | undefined;
    const result = await this.passkeyService.verifyAuthentication(body, userAgent);

    const auth = await this.authService.loginWithPasskey(result.userId, {
      device: userAgent ?? undefined,
      browser: userAgent ?? undefined,
      ipAddress:
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.socket?.remoteAddress ||
        undefined,
    });

    return auth;
  }

  /**
   * GET /auth/passkey/credentials
   *
   * Lists all passkeys registered for the current user.
   */
  @Get('credentials')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'List passkeys for the current user' })
  listCredentials(@CurrentUser() user: AuthenticatedUser) {
    return this.passkeyService.listCredentials(user.id);
  }

  /**
   * DELETE /auth/passkey/credentials/:id
   *
   * Removes a specific passkey credential.
   */
  @Delete('credentials/:id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Remove a passkey credential' })
  async removeCredential(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') credentialId: string,
  ) {
    if (!credentialId) {
      throw new NotFoundException('Passkey credential');
    }
    await this.passkeyService.removeCredential(user.id, credentialId);
    return { success: true as const };
  }
}
