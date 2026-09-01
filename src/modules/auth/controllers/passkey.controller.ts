
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';

import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';

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

  verifyPasskeyAuthenticationSchema,
  VerifyPasskeyAuthenticationInput,
  VerifyPasskeyRegistrationDto,

  PasskeyCredentialDto,
  RegistrationOptionsDto,
  AuthenticationOptionsDto,
  VerifyPasskeyAuthenticationDto,
  PasskeyAuthenticationResultDto,
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

 * Registration flow:
 *   1. POST /auth/passkey/register/options — obtain registration challenge
 *   2. Client completes WebAuthn ceremony via @simplewebauthn/browser
 *   3. POST /auth/passkey/register/verify — verify and persist credential
 *
 * Authentication flow:
 *   1. POST /auth/passkey/authenticate/options — obtain authentication challenge
 *   2. Client completes WebAuthn ceremony via @simplewebauthn/browser
 *   3. POST /auth/passkey/authenticate/verify — verify assertion

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

  // ────────────────────────────────────────────
  // Registration endpoints
  // ────────────────────────────────────────────

  /**
   * POST /auth/passkey/register/options
   *
   * Generates registration options including a challenge for the client to
   * present to the authenticator. Stores the challenge for later verification.
   */
  @Post('register/options')
  @ApiBearerAuth('access-token')
  @ThrottleTierDecorator('auth')
  @ApiOperation({
    summary: 'Generate WebAuthn registration options',
    description:
      'Returns a challenge and relying party configuration for the client ' +
      'to pass to navigator.credentials.create().',
  })
  @ApiResponse({
    status: 201,
    description: 'Registration options generated successfully',
    type: RegistrationOptionsDto,
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async generateRegistrationOptions(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RegistrationOptionsDto> {
    return this.passkeyService.generateRegistrationOptions(user.id) as Promise<RegistrationOptionsDto>;
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
  @ApiBody({ type: VerifyPasskeyRegistrationDto })
  @ApiResponse({
    status: 201,
    description: 'Passkey credential created successfully',
    type: PasskeyCredentialDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid or expired registration challenge' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
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

  // ────────────────────────────────────────────
  // Authentication endpoints
  // ────────────────────────────────────────────

  /**
   * POST /auth/passkey/authenticate/options
   *
   * Generates authentication options including a challenge for the client's
   * registered passkey. Returns the list of allowed credentials.
   */
  @Post('authenticate/options')
  @ApiBearerAuth('access-token')
  @ThrottleTierDecorator('auth')
  @ApiOperation({
    summary: 'Generate WebAuthn authentication options',
    description:
      'Returns a challenge and allowed credentials for the client ' +
      'to pass to navigator.credentials.get().',
  })
  @ApiResponse({
    status: 201,
    description: 'Authentication options generated successfully',
    type: AuthenticationOptionsDto,
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async generateAuthenticationOptions(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AuthenticationOptionsDto> {
    return this.passkeyService.generateAuthenticationOptions(user.id) as Promise<AuthenticationOptionsDto>;
  }

  /**
   * POST /auth/passkey/authenticate/verify
   *
   * Verifies the authentication assertion response, updates the credential
   * counter to prevent replay, and returns the authenticated user.
   */
  @Post('authenticate/verify')
  @ApiBearerAuth('access-token')
  @ThrottleTierDecorator('auth')
  @ApiOperation({
    summary: 'Verify a WebAuthn authentication assertion',
    description:
      'Validates the assertion credential from @simplewebauthn/browser, ' +
      'updates the signature counter, and returns the authenticated user.',
  })
  @ApiBody({ type: VerifyPasskeyAuthenticationDto })
  @ApiResponse({
    status: 200,
    description: 'Authentication successful',
    type: PasskeyAuthenticationResultDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid or expired authentication challenge' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async verifyAuthentication(
    @Body(new ZodValidationPipe(verifyPasskeyAuthenticationSchema))
    body: VerifyPasskeyAuthenticationInput,
  ): Promise<PasskeyAuthenticationResultDto> {
    return this.passkeyService.verifyAuthentication(body);
  }

  // ────────────────────────────────────────────
  // Credential management endpoints
  // ────────────────────────────────────────────

  /**
   * GET /auth/passkey/credentials
   *
   * Lists all registered passkey credentials for the authenticated user.
   */
  @Get('credentials')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List registered passkey credentials',
    description: 'Returns all passkey credentials for the authenticated user.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of registered passkey credentials',
    type: [PasskeyCredentialDto],
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })

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

   * DELETE /auth/passkey/credentials/:credentialId
   *
   * Revokes (deletes) a specific passkey credential.
   */
  @Delete('credentials/:credentialId')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Revoke a passkey credential',
    description: 'Deletes a registered passkey credential by its ID.',
  })
  @ApiParam({
    name: 'credentialId',
    description: 'The unique identifier of the passkey credential to revoke',
    example: 'cred_018f...',
  })
  @ApiResponse({ status: 200, description: 'Credential revoked successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Credential not found' })
  revokeCredential(
    @CurrentUser() user: AuthenticatedUser,
    @Param('credentialId') credentialId: string,
  ) {
    return this.passkeyService.revokeCredential(user.id, credentialId);
  }
}
