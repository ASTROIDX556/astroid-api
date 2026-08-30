import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { ThrottleTierDecorator } from '../../../common/decorators/throttle-tier.decorator';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import {
  verifyPasskeyRegistrationSchema,
  VerifyPasskeyRegistrationInput,
  verifyPasskeyAuthenticationSchema,
  VerifyPasskeyAuthenticationInput,
  PasskeyCredentialDto,
  RegistrationOptionsDto,
  AuthenticationOptionsDto,
  PasskeyAuthenticationResultDto,
} from '../dto/passkey.dto';
import { PasskeyService } from '../services/passkey.service';

/**
 * WebAuthn passkey endpoints.
 *
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
  constructor(private readonly passkeyService: PasskeyService) {}

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
  async verifyAuthentication(
    @Body(new ZodValidationPipe(verifyPasskeyAuthenticationSchema))
    body: VerifyPasskeyAuthenticationInput,
  ): Promise<PasskeyAuthenticationResultDto> {
    return this.passkeyService.verifyAuthentication(body);
  }

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
  listCredentials(@CurrentUser() user: AuthenticatedUser) {
    return this.passkeyService.listCredentials(user.id);
  }

  /**
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
  revokeCredential(
    @CurrentUser() user: AuthenticatedUser,
    @Param('credentialId') credentialId: string,
  ) {
    return this.passkeyService.revokeCredential(user.id, credentialId);
  }
}
