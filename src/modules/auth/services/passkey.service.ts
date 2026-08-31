import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
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

/** Challenge TTL in milliseconds (5 minutes). */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface PasskeyRegistrationResult {
  credentialId: string;
  publicKey: string;
  counter: number;
}

export interface PasskeyAuthenticationResult {
  credentialId: string;
  userId: string;
  newCounter: number;
}

/**
 * Handles the full WebAuthn passkey lifecycle:
 *   1. Registration options generation + challenge storage
 *   2. Registration verification + credential persistence
 *   3. Authentication options generation + challenge storage
 *   4. Authentication verification + counter update
 *
 * Challenges are stored in the database with a short TTL to prevent replay
 * attacks. Cryptographic verification is delegated to `@simplewebauthn/server`.
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

  // ── Registration ───────────────────────────────────────────────────────

  /**
   * Generates WebAuthn registration options (challenge) for a user who is
   * already authenticated and wants to register a new passkey.
   *
   * The challenge is persisted in the database with a 5-minute TTL. Existing
   * challenges for the user are cleaned up first.
   *
   * @throws NotFoundException if the user does not exist
   */
  async generateRegistrationOptions(
    userId: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User', userId);
    }

    // Fetch existing credentials to exclude from registration
    const existingCredentials = await this.prisma.passkeyCredential.findMany({
      where: { userId },
      select: { credentialId: true },
    });

    const options = await generateRegistrationOptions({
      rpName: this.auth.passkey.rpName,
      rpID: this.auth.passkey.rpId,
      userName: user.email,
      userDisplayName: user.name,
      attestationType: 'none',
      excludeCredentials: existingCredentials.map((cred) => ({
        id: cred.credentialId,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    // Store the challenge and clean up any previous ones atomically
    await this.prisma.$transaction([
      this.prisma.passkeyChallenge.deleteMany({ where: { userId } }),
      this.prisma.passkeyChallenge.create({
        data: {
          userId,
          challenge: options.challenge,
          expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
        },
      }),
    ]);

    this.logger.debug(`Generated registration options for user ${userId}`);
    return options;
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
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User', userId);
    }

    const challengeRecord = await this.prisma.passkeyChallenge.findFirst({
      where: { userId, expiresAt: { gt: new Date() } },
    });

    if (!challengeRecord) {
      throw new ValidationException(
        'No active registration challenge found. Please request a new one.',
      );
    }

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
    const publicKey = bufferToBase64url(webauthnCredential.publicKey);

    const saved = await this.prisma.$transaction(async (tx) => {
      await tx.passkeyChallenge.deleteMany({ where: { userId } });
      return tx.passkeyCredential.create({
        data: {
          userId,
          credentialId: webauthnCredential.id,
          publicKey,
          counter: webauthnCredential.counter,
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

  // ── Authentication ─────────────────────────────────────────────────────

  /**
   * Generates WebAuthn authentication options (challenge) for a user
   * identified by email. The client must supply the email so the server can
   * look up existing credentials and populate `allowCredentials`.
   *
   * @throws NotFoundException if no user with the given email exists
   * @throws ValidationException if the user has no registered passkeys
   */
  async generateAuthenticationOptions(
    email: string,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      throw new NotFoundException('User', email);
    }

    const credentials = await this.prisma.passkeyCredential.findMany({
      where: { userId: user.id },
      select: { credentialId: true },
    });

    if (credentials.length === 0) {
      throw new ValidationException(
        'No passkeys registered for this account. Please register a passkey first.',
      );
    }

    const options = await generateAuthenticationOptions({
      rpID: this.auth.passkey.rpId,
      allowCredentials: credentials.map((cred) => ({
        id: cred.credentialId,
      })),
      userVerification: 'preferred',
    });

    // Store the challenge and clean up any previous ones atomically
    await this.prisma.$transaction([
      this.prisma.passkeyChallenge.deleteMany({ where: { userId: user.id } }),
      this.prisma.passkeyChallenge.create({
        data: {
          userId: user.id,
          challenge: options.challenge,
          expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
        },
      }),
    ]);

    this.logger.debug(
      `Generated authentication options for user ${user.id} (${email})`,
    );
    return options;
  }

  /**
   * Verifies a WebAuthn authentication response (assertion) and updates the
   * credential's signature counter for replay protection.
   *
   * Returns the authenticated user's ID so the caller can issue session tokens.
   *
   * @throws ValidationException if no active challenge exists
   * @throws NotFoundException if the credential is not registered
   * @throws UnauthorizedException if cryptographic verification fails
   */
  async verifyAuthentication(
    input: VerifyPasskeyAuthenticationInput,
    userAgent?: string,
  ): Promise<PasskeyAuthenticationResult> {
    const credential = input.credential as AuthenticationResponseJSON;

    // Look up the stored credential by its ID
    const storedCredential = await this.prisma.passkeyCredential.findUnique({
      where: { credentialId: credential.id },
    });

    if (!storedCredential) {
      throw new NotFoundException('Passkey credential', credential.id);
    }

    // Fetch the stored challenge for this user
    const challengeRecord = await this.prisma.passkeyChallenge.findFirst({
      where: {
        userId: storedCredential.userId,
        expiresAt: { gt: new Date() },
      },
    });

    if (!challengeRecord) {
      throw new ValidationException(
        'No active authentication challenge found. Please request a new one.',
      );
    }

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: this.auth.passkey.origin,
      expectedRPID: this.auth.passkey.rpId,
      credential: {
        id: storedCredential.credentialId,
        publicKey: base64urlToBuffer(storedCredential.publicKey),
        counter: storedCredential.counter,
      },
    });

    if (!verification.verified) {
      throw new UnauthorizedException(
        'Passkey authentication verification failed — invalid assertion response.',
      );
    }

    const { authenticationInfo } = verification;

    // Invalidate challenge and update the credential counter atomically
    await this.prisma.$transaction([
      this.prisma.passkeyChallenge.deleteMany({
        where: { userId: storedCredential.userId },
      }),
      this.prisma.passkeyCredential.update({
        where: { id: storedCredential.id },
        data: {
          counter: authenticationInfo.newCounter,
          userAgent: userAgent ?? storedCredential.userAgent,
        },
      }),
    ]);

    this.logger.log(
      `Passkey authenticated for user ${storedCredential.userId}: ` +
        `credential ${authenticationInfo.credentialID} (counter: ${authenticationInfo.newCounter})`,
    );

    return {
      credentialId: authenticationInfo.credentialID,
      userId: storedCredential.userId,
      newCounter: authenticationInfo.newCounter,
    };
  }

  // ── Credential management ──────────────────────────────────────────────

  /**
   * Lists all passkeys registered for a user.
   */
  async listCredentials(userId: string) {
    return this.prisma.passkeyCredential.findMany({
      where: { userId },
      select: {
        id: true,
        credentialId: true,
        deviceName: true,
        userAgent: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Deletes a specific passkey credential. The user must have at least one
   * remaining passkey or an alternative authentication method.
   *
   * @throws NotFoundException if the credential does not exist
   */
  async removeCredential(userId: string, credentialId: string) {
    const credential = await this.prisma.passkeyCredential.findFirst({
      where: { id: credentialId, userId },
    });

    if (!credential) {
      throw new NotFoundException('Passkey credential', credentialId);
    }

    await this.prisma.passkeyCredential.delete({
      where: { id: credentialId },
    });

    this.logger.log(
      `Passkey credential ${credentialId} removed for user ${userId}`,
    );
  }
}

// ── Helpers ──

function bufferToBase64url(buffer: Uint8Array): string {
  return Buffer.from(buffer).toString('base64url');
}

function base64urlToBuffer(base64url: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64url, 'base64url'));
}
