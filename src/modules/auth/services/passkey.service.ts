import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { PrismaService } from '../../../database/prisma.service';
import { AuthConfig } from '../../../config/auth.config';
import {
  VerifyPasskeyRegistrationInput,
  VerifyPasskeyAuthenticationInput,
} from '../dto/passkey.dto';
import {
  UnauthorizedException,
  ValidationException,
  NotFoundException,
} from '../../../common/exceptions/domain.exception';

export interface PasskeyRegistrationResult {
  credentialId: string;
  publicKey: string;
  counter: number;
}

export interface PasskeyRegistrationOptions {
  challenge: string;
  rp: { name: string; id: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ alg: number; type: string }>;
  timeout: number;
  attestation: string;
  authenticatorSelection: Record<string, unknown>;
}

export interface PasskeyAuthenticationOptions {
  challenge: string;
  rpId: string;
  timeout: number;
  allowCredentials: Array<{ id: string; type: string; transports?: string[] }>;
  userVerification: string;
}

export interface PasskeyAuthenticationResult {
  verified: boolean;
  userId?: string;
}

/**
 * Handles WebAuthn passkey registration and authentication flows.
 *
 * Registration:
 *   1. generateRegistrationOptions — creates a challenge for the authenticator
 *   2. verifyRegistrationResponse — cryptographically verifies the attestation
 *
 * Authentication:
 *   1. generateAuthenticationOptions — creates a challenge for the authenticator
 *   2. verifyAuthenticationResponse — cryptographically verifies the assertion
 *
 * Uses `@simplewebauthn/server` for all cryptographic operations. Challenges are
 * stored temporarily in the database and invalidated after use to prevent replay.
 */
@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);
  private readonly auth: AuthConfig;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.auth = config.getOrThrow<AuthConfig>('auth');
  }

  /**
   * Generates WebAuthn registration options (challenge) for a user.
   *
   * Steps:
   * 1. Confirm the user exists.
   * 2. Fetch existing credentials to exclude from new registration.
   * 3. Generate options with @simplewebauthn/server.
   * 4. Store the challenge for later verification.
   *
   * @throws NotFoundException if the user does not exist
   */
  async generateRegistrationOptions(
    userId: string,
  ): Promise<PasskeyRegistrationOptions> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User', userId);
    }

    // Fetch existing credentials to exclude from new registration
    const existingCredentials = await this.prisma.passkeyCredential.findMany({
      where: { userId },
      select: { credentialId: true },
    });

    const options = await generateRegistrationOptions({
      rpName: this.auth.passkey.rpName,
      rpID: this.auth.passkey.rpId,
      userID: Buffer.from(userId),
      userName: user.email,
      userDisplayName: user.name,
      attestationType: 'none',
      excludeCredentials: existingCredentials.map((cred) => ({
        id: cred.credentialId,
        type: 'public-key' as const,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    // Store the challenge for later verification (expires in 5 minutes)
    await this.prisma.passkeyChallenge.create({
      data: {
        userId,
        challenge: options.challenge,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    this.logger.log(
      `Registration options generated for user ${userId}: challenge ${options.challenge.substring(0, 16)}...`,
    );

    return {
      challenge: options.challenge,
      rp: options.rp as { name: string; id: string },
      user: options.user as { id: string; name: string; displayName: string },
      pubKeyCredParams: options.pubKeyCredParams as Array<{ alg: number; type: string }>,
      timeout: options.timeout ?? 60000,
      attestation: options.attestation ?? 'none',
      authenticatorSelection: options.authenticatorSelection as Record<string, unknown>,
    };
  }

  /**
   * Verifies a WebAuthn registration response and persists the new credential.
   *
   * Steps:
   * 1. Confirm the user exists in the database.
   * 2. Delegate to @simplewebauthn/server for cryptographic verification of the
   *    attestation (checks challenge match, origin, RP ID, signature, etc.).
   * 3. Within a transaction, invalidate the stored challenge and persist the
   *    credential — both succeed or both fail.
   *
   * @throws NotFoundException  if the user does not exist
   * @throws ValidationException if the challenge was not previously stored
   * @throws UnauthorizedException if cryptographic verification fails
   */
  async verifyRegistration(
    userId: string,
    input: VerifyPasskeyRegistrationInput,
    userAgent?: string,
  ): Promise<PasskeyRegistrationResult> {
    // 1. Confirm user exists
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User', userId);
    }

    // 2. Fetch the stored challenge
    const challengeRecord = await this.prisma.passkeyChallenge.findFirst({
      where: { userId, expiresAt: { gt: new Date() } },
    });

    if (!challengeRecord) {
      throw new ValidationException(
        'No active registration challenge found. Please request a new one.',
      );
    }

    // 3. Cryptographic verification via @simplewebauthn/server
    const credential = input.credential as RegistrationResponseJSON;
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: this.auth.passkey.origin,
      expectedRPID: this.auth.passkey.rpId,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new UnauthorizedException(
        'Passkey registration verification failed — invalid credential response.',
      );
    }

    const { credential: webauthnCredential } = verification.registrationInfo;
    const counter = webauthnCredential.counter;

    // Convert the Uint8Array public key to a base64url string for storage.
    const publicKey = bufferToBase64url(webauthnCredential.publicKey);

    // 4. Atomic: invalidate challenge + persist credential
    const saved = await this.prisma.$transaction(async (tx) => {
      // Invalidate the challenge to prevent replay
      await tx.passkeyChallenge.deleteMany({
        where: { userId },
      });

      // Persist the verified credential
      return tx.passkeyCredential.create({
        data: {
          userId,
          credentialId: webauthnCredential.id,
          publicKey,
          counter,
          deviceName: input.deviceName ?? null,
          userAgent: userAgent ?? null,
        },
      });
    });

    this.logger.log(
      `Passkey registered for user ${userId}: credential ${saved.credentialId}`,
    );

    return {
      credentialId: saved.credentialId,
      publicKey: saved.publicKey,
      counter: saved.counter,
    };
  }

  /**
   * Generates WebAuthn authentication options (challenge) for a user's passkey.
   *
   * Steps:
   * 1. Fetch the user's stored credentials.
   * 2. Generate options with @simplewebauthn/server.
   * 3. Store the challenge for later verification.
   *
   * @throws NotFoundException if the user has no registered credentials
   */
  async generateAuthenticationOptions(
    userId: string,
  ): Promise<PasskeyAuthenticationOptions> {
    const credentials = await this.prisma.passkeyCredential.findMany({
      where: { userId },
      select: { credentialId: true },
    });

    if (credentials.length === 0) {
      throw new NotFoundException('Passkey credentials', userId);
    }

    const options = await generateAuthenticationOptions({
      rpID: this.auth.passkey.rpId,
      allowCredentials: credentials.map((cred) => ({
        id: cred.credentialId,
        type: 'public-key' as const,
      })),
      userVerification: 'preferred',
    });

    // Store the challenge for later verification (expires in 5 minutes)
    await this.prisma.passkeyChallenge.create({
      data: {
        userId,
        challenge: options.challenge,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    this.logger.log(
      `Authentication options generated for user ${userId}: challenge ${options.challenge.substring(0, 16)}...`,
    );

    return {
      challenge: options.challenge,
      rpId: this.auth.passkey.rpId,
      timeout: options.timeout ?? 60000,
      allowCredentials: (options.allowCredentials ?? []).map((cred) => ({
        id: cred.id,
        type: 'public-key' as const,
        transports: cred.transports as string[] | undefined,
      })),
      userVerification: options.userVerification ?? 'preferred',
    };
  }

  /**
   * Verifies a WebAuthn authentication assertion and returns the authenticated user.
   *
   * Steps:
   * 1. Fetch the stored challenge and the credential being used.
   * 2. Delegate to @simplewebauthn/server for cryptographic verification.
   * 3. Update the credential counter to prevent replay attacks.
   * 4. Invalidate the challenge.
   *
   * @throws ValidationException if the challenge was not previously stored
   * @throws UnauthorizedException if cryptographic verification fails
   * @throws NotFoundException if the credential does not exist
   */
  async verifyAuthentication(
    input: VerifyPasskeyAuthenticationInput,
  ): Promise<PasskeyAuthenticationResult> {
    // 1. Fetch the stored challenge
    const challengeRecord = await this.prisma.passkeyChallenge.findFirst({
      where: {
        challenge: input.expectedChallenge,
        expiresAt: { gt: new Date() },
      },
    });

    if (!challengeRecord) {
      throw new ValidationException(
        'No active authentication challenge found. Please request a new one.',
      );
    }

    // 2. Fetch the credential being used
    const credentialRecord = await this.prisma.passkeyCredential.findUnique({
      where: { credentialId: input.credentialId },
    });

    if (!credentialRecord) {
      throw new NotFoundException('Passkey credential', input.credentialId);
    }

    // 3. Cryptographic verification via @simplewebauthn/server
    const credential = input.credential as AuthenticationResponseJSON;
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: this.auth.passkey.origin,
      expectedRPID: this.auth.passkey.rpId,
      credential: {
        id: credentialRecord.credentialId,
        publicKey: base64urlToBuffer(credentialRecord.publicKey),
        counter: credentialRecord.counter,
      },
    });

    if (!verification.verified) {
      throw new UnauthorizedException(
        'Passkey authentication verification failed — invalid assertion response.',
      );
    }

    // 4. Atomic: update counter + invalidate challenge
    await this.prisma.$transaction(async (tx) => {
      // Update the credential counter to prevent replay
      await tx.passkeyCredential.update({
        where: { credentialId: input.credentialId },
        data: { counter: verification.authenticationInfo.newCounter },
      });

      // Invalidate the challenge
      await tx.passkeyChallenge.deleteMany({
        where: { userId: challengeRecord.userId },
      });
    });

    this.logger.log(
      `Passkey authenticated for user ${challengeRecord.userId}: credential ${input.credentialId}`,
    );

    return {
      verified: true,
      userId: challengeRecord.userId,
    };
  }

  /**
   * Lists all registered passkey credentials for a user.
   */
  async listCredentials(userId: string) {
    return this.prisma.passkeyCredential.findMany({
      where: { userId },
      select: {
        id: true,
        credentialId: true,
        deviceName: true,
        userAgent: true,
        counter: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Deletes a passkey credential (revokes access).
   */
  async revokeCredential(userId: string, credentialId: string): Promise<void> {
    const credential = await this.prisma.passkeyCredential.findUnique({
      where: { credentialId },
    });

    if (!credential || credential.userId !== userId) {
      throw new NotFoundException('Passkey credential', credentialId);
    }

    await this.prisma.passkeyCredential.delete({
      where: { credentialId },
    });

    this.logger.log(`Passkey revoked for user ${userId}: credential ${credentialId}`);
  }
}

// ── Helpers ──

/**
 * Converts a Uint8Array to a URL-safe base64 string (no padding).
 * This is the standard encoding for WebAuthn credential IDs and keys.
 */
function bufferToBase64url(buffer: Uint8Array): string {
  const bytes = Buffer.from(buffer);
  return bytes.toString('base64url');
}

/**
 * Converts a base64url string back to a Uint8Array for cryptographic operations.
 */
function base64urlToBuffer(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'base64url'));
}
