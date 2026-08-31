import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── Zod schemas (runtime validation) ──

const authenticatorAttachmentSchema = z.enum(['platform', 'cross-platform']);

const credentialResponseSchema = z.object({
  id: z.string().min(1),
  rawId: z.string().min(1),
  response: z.object({
    attestationObject: z.string().min(1),
    clientDataJSON: z.string().min(1),
  }),
  authenticatorAttachment: authenticatorAttachmentSchema.optional(),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.unknown()).optional(),
});

const assertionResponseSchema = z.object({
  id: z.string().min(1),
  rawId: z.string().min(1),
  response: z.object({
    clientDataJSON: z.string().min(1),
    authenticatorData: z.string().min(1),
    signature: z.string().min(1),
    userHandle: z.string().optional(),
  }),
  authenticatorAttachment: authenticatorAttachmentSchema.optional(),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.unknown()).optional(),
});

// ── Registration schemas ──

export const verifyPasskeyRegistrationSchema = z.object({
  expectedChallenge: z.string().min(1),
  credential: credentialResponseSchema,
  deviceName: z.string().max(120).optional(),
});

export type VerifyPasskeyRegistrationInput = z.infer<
  typeof verifyPasskeyRegistrationSchema
>;

// ── Authentication schemas ──

export const generateAuthenticationOptionsSchema = z.object({
  email: z.string().email(),
});

export type GenerateAuthenticationOptionsInput = z.infer<
  typeof generateAuthenticationOptionsSchema
>;

export const verifyPasskeyAuthenticationSchema = z.object({
  expectedChallenge: z.string().min(1),
  credential: assertionResponseSchema,
});

export type VerifyPasskeyAuthenticationInput = z.infer<
  typeof verifyPasskeyAuthenticationSchema
>;


// ── Swagger DTOs (documentation only — validation is done by Zod pipe) ──

// ── Authentication schemas ──

/**
 * Authentication assertion response from @simplewebauthn/browser.
 * Matches the `AuthenticationResponseJSON` shape from the SimpleWebAuthn spec.
 */
const authenticationResponseSchema = z.object({
  id: z.string().min(1),
  rawId: z.string().min(1),
  response: z.object({
    authenticatorData: z.string().min(1),
    clientDataJSON: z.string().min(1),
    signature: z.string().min(1),
    userHandle: z.string().optional(),
  }),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.unknown()).optional(),
});

export const verifyPasskeyAuthenticationSchema = z.object({
  /** The original base64url challenge that was sent to generateAuthenticationOptions. */
  expectedChallenge: z.string().min(1),
  /** The credential assertion response from the client. */
  credential: authenticationResponseSchema,
  /** The credential ID of the passkey being used for authentication. */
  credentialId: z.string().min(1),
});

export type VerifyPasskeyAuthenticationInput = z.infer<typeof verifyPasskeyAuthenticationSchema>;

// ── Swagger DTO (documentation only — validation is done by Zod pipe) ──


class CredentialResponseDto {
  @ApiProperty({ description: 'Base64url credential ID' })
  id!: string;

  @ApiProperty({ description: 'Base64url-encoded raw credential ID' })
  rawId!: string;

  @ApiProperty({ description: 'Authenticator response payloads' })
  response!: {
    attestationObject: string;
    clientDataJSON: string;
  };

  @ApiPropertyOptional({ enum: ['platform', 'cross-platform'] })
  authenticatorAttachment?: 'platform' | 'cross-platform';

  @ApiProperty({ enum: ['public-key'] })
  type!: 'public-key';

  @ApiPropertyOptional({ description: 'WebAuthn client extension results' })
  clientExtensionResults?: Record<string, unknown>;
}

class AssertionResponseDto {
  @ApiProperty({ description: 'Base64url credential ID' })
  id!: string;

  @ApiProperty({ description: 'Base64url-encoded raw credential ID' })
  rawId!: string;

  @ApiProperty({ description: 'Authenticator assertion payloads' })
  response!: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };

  @ApiPropertyOptional({ enum: ['platform', 'cross-platform'] })
  authenticatorAttachment?: 'platform' | 'cross-platform';

  @ApiProperty({ enum: ['public-key'] })
  type!: 'public-key';

  @ApiPropertyOptional({ description: 'WebAuthn client extension results' })
  clientExtensionResults?: Record<string, unknown>;
}

export class VerifyPasskeyRegistrationDto {
  @ApiProperty({
    description:
      'The base64url challenge previously returned by the registration options endpoint',
  })
  expectedChallenge!: string;

  @ApiProperty({ description: 'Credential response from @simplewebauthn/browser' })
  credential!: CredentialResponseDto;

  @ApiPropertyOptional({ description: 'Device name (e.g. "YubiKey 5", "macOS Touch ID")' })
  deviceName?: string;
}

export class PasskeyCredentialDto {
  @ApiProperty({ description: 'Unique WebAuthn credential ID' })
  credentialId!: string;

  @ApiProperty({ description: 'Base64url-encoded credential public key' })
  publicKey!: string;

  @ApiProperty({ description: 'Signature counter for replay protection' })
  counter!: number;
}


export class GenerateAuthenticationOptionsDto {
  @ApiProperty({ description: 'Email address of the user authenticating' })
  email!: string;

class AuthenticationResponseDto {
  @ApiProperty({ description: 'Base64url credential ID' })
  id!: string;

  @ApiProperty({ description: 'Base64url-encoded raw credential ID' })
  rawId!: string;

  @ApiProperty({ description: 'Authenticator assertion response payloads' })
  response!: {
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
    userHandle?: string;
  };

  @ApiProperty({ enum: ['public-key'] })
  type!: 'public-key';

  @ApiPropertyOptional({ description: 'WebAuthn client extension results' })
  clientExtensionResults?: Record<string, unknown>;

}

export class VerifyPasskeyAuthenticationDto {
  @ApiProperty({
    description:
      'The base64url challenge previously returned by the authentication options endpoint',
  })
  expectedChallenge!: string;

  @ApiProperty({ description: 'Assertion response from @simplewebauthn/browser' })

  credential!: AssertionResponseDto;
}

export class PasskeyRegistrationOptionsDto {
  @ApiProperty({ description: 'Relying party information' })
  rp!: { name: string; id: string };

  @ApiProperty({ description: 'User information for the credential' })
  user!: { id: string; name: string; displayName: string };

  @ApiProperty({ description: 'Base64url-encoded challenge' })
  challenge!: string;

  @ApiProperty({ description: 'Preferred public key credential parameters' })
  pubKeyCredParams!: Array<{ alg: number; type: string }>;

  @ApiPropertyOptional({ description: 'Timeout in milliseconds' })
  timeout?: number;

  @ApiPropertyOptional({ description: 'Credentials to exclude' })
  excludeCredentials?: Array<{ id: string; type: string }>;

  @ApiPropertyOptional({ description: 'Authenticator selection criteria' })
  authenticatorSelection?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: ['none', 'direct', 'enterprise'] })
  attestation?: string;
}

export class PasskeyAuthenticationOptionsDto {
  @ApiProperty({ description: 'Base64url-encoded challenge' })
  challenge!: string;

  @ApiPropertyOptional({ description: 'Timeout in milliseconds' })
  timeout?: number;

  @ApiPropertyOptional({ description: 'RP ID' })
  rpId?: string;

  @ApiPropertyOptional({ description: 'Allowed credentials' })
  allowCredentials?: Array<{ id: string; type: string }>;

  @ApiPropertyOptional({ enum: ['required', 'preferred', 'discouraged'] })
  userVerification?: string;

  credential!: AuthenticationResponseDto;

  @ApiProperty({ description: 'Credential ID of the passkey being used' })
  credentialId!: string;
}

export class RegistrationOptionsDto {
  @ApiProperty({ description: 'Generated registration options for the client' })
  challenge!: string;

  @ApiProperty({ description: 'Relying party information' })
  rp!: { name: string; id: string };

  @ApiProperty({ description: 'User information for registration' })
  user!: { id: string; name: string; displayName: string };

  @ApiProperty({ description: 'Credential parameters' })
  pubKeyCredParams!: Array<{ alg: number; type: string }>;

  @ApiProperty({ description: 'Timeout in milliseconds' })
  timeout!: number;

  @ApiProperty({ description: 'Attestation preference' })
  attestation!: string;

  @ApiProperty({ description: 'Authenticator selection criteria' })
  authenticatorSelection!: Record<string, unknown>;
}

export class AuthenticationOptionsDto {
  @ApiProperty({ description: 'Generated authentication challenge for the client' })
  challenge!: string;

  @ApiProperty({ description: 'Relying party ID' })
  rpId!: string;

  @ApiProperty({ description: 'Timeout in milliseconds' })
  timeout!: number;

  @ApiProperty({ description: 'Allowed credentials for authentication' })
  allowCredentials!: Array<{ id: string; type: string; transports?: string[] }>;

  @ApiProperty({ description: 'User verification preference' })
  userVerification!: string;
}

export class PasskeyAuthenticationResultDto {
  @ApiProperty({ description: 'Whether authentication was successful' })
  verified!: boolean;

  @ApiProperty({ description: 'User ID if authentication succeeded' })
  userId?: string;

}
