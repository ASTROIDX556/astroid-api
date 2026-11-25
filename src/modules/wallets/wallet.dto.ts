import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StellarNetwork, WalletType, WalletStatus } from '@prisma/client';
import { stellarEd25519PublicKeySchema } from '../../common/validators/stellar-address.schema';
import { sanitizeTextField } from '../../common/validators/text-field.sanitizer';

/** Maximum length of a wallet label. */
export const WALLET_LABEL_MAX_LENGTH = 120;

/**
 * A wallet label: the short, human-readable name of a wallet.
 *
 * The value is normalized (interior whitespace collapsed, ends trimmed)
 * before it is stored, so "Treasury  Ops " and "Treasury Ops" are the same
 * label. An empty label is rejected: a nameless wallet is always a caller
 * mistake rather than a meaningful request.
 */
export const walletLabelSchema = z
  .string()
  .max(WALLET_LABEL_MAX_LENGTH, `Label must be at most ${WALLET_LABEL_MAX_LENGTH} characters`)
  .transform(sanitizeTextField)
  .refine((value) => value.length > 0, 'Label must not be empty')
  .refine(
    (value) => value.length <= WALLET_LABEL_MAX_LENGTH,
    `Label must be at most ${WALLET_LABEL_MAX_LENGTH} characters`,
  );

/**
 * Create a wallet. Two modes:
 *  - generate (default): the server mints a fresh Stellar keypair; the secret is
 *    returned to the caller EXACTLY ONCE and never stored (non-custodial).
 *  - import: the caller supplies an existing public `stellarAddress` to track.
 *
 * The platform is non-custodial: it never derives keys from a seed and never
 * stores a secret, so there is no derivation path, passphrase or wallet
 * metadata to accept. The only cryptographic parameter of a request is the
 * Ed25519 public key of an imported wallet, which is validated with the
 * Stellar strkey checksum.
 */
export const createWalletSchema = z
  .object({
    label: walletLabelSchema.optional(),
    walletType: z.nativeEnum(WalletType).default(WalletType.AGENT),
    network: z.nativeEnum(StellarNetwork).default(StellarNetwork.TESTNET),
    agentId: z.string().uuid('agentId must be a valid UUID').optional(),
    /**
     * When provided, the wallet is imported (address-only) rather than
     * generated. Only Stellar accounts are accepted: a contract ID (`C…`) or a
     * multiplexed address (`M…`) cannot hold a balance or sign for the wallet.
     */
    stellarAddress: stellarEd25519PublicKeySchema.optional(),
  })
  .strict();
export type CreateWalletInput = z.infer<typeof createWalletSchema>;

/**
 * Update a wallet. Every field is optional, but a request must change
 * something: an empty body would be a no-op that still writes an audit entry.
 */
export const updateWalletSchema = z
  .object({
    label: walletLabelSchema.optional(),
    agentId: z.string().uuid('agentId must be a valid UUID').nullable().optional(),
  })
  .strict()
  .refine((data) => data.label !== undefined || data.agentId !== undefined, {
    message: 'Provide at least one field to update',
    path: ['body'],
  });
export type UpdateWalletInput = z.infer<typeof updateWalletSchema>;

// ── Swagger DTOs (documentation only; validation is done by Zod pipes) ──

export class CreateWalletDto {
  @ApiPropertyOptional({
    example: 'Treasury – Operations',
    description: 'Human-readable label for the wallet',
    minLength: 1,
    maxLength: 120,
  })
  label?: string;

  @ApiPropertyOptional({
    enum: WalletType,
    enumName: 'WalletType',
    description: 'Type of wallet (determines usage context)',
    example: 'AGENT',
  })
  walletType?: WalletType;

  @ApiPropertyOptional({
    enum: StellarNetwork,
    enumName: 'StellarNetwork',
    description: 'Stellar network the wallet operates on',
    example: 'TESTNET',
  })
  network?: StellarNetwork;

  @ApiPropertyOptional({
    description: 'UUID of the agent that owns this wallet (optional)',
    format: 'uuid',
  })
  agentId?: string;

  @ApiPropertyOptional({
    description:
      'Import an existing Stellar account address (G…) instead of generating a new keypair. ' +
      'Contract IDs (C…) and multiplexed addresses (M…) are rejected.',
    example: 'GD5I3Q7IK...',
  })
  stellarAddress?: string;
}

export class UpdateWalletDto {
  @ApiPropertyOptional({
    description: 'Updated human-readable label for the wallet',
    minLength: 1,
    maxLength: 120,
  })
  label?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Reassign or clear the owning agent',
    format: 'uuid',
  })
  agentId?: string | null;
}

export class WalletSecretDto {
  @ApiProperty({ description: 'Public Stellar address (G...)', example: 'GD5I3Q7IK...' })
  stellarAddress!: string;

  @ApiProperty({
    description:
      'The generated secret key (S...). Shown ONCE and never stored server-side. Persist it securely now.',
    example: 'SAB5...',
  })
  secretKey!: string;
}

export class WalletResponseDto {
  @ApiProperty({ description: 'Wallet UUID', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Organization UUID', format: 'uuid' })
  organizationId!: string;

  @ApiPropertyOptional({ description: 'Agent UUID if wallet is agent-owned', format: 'uuid' })
  agentId?: string;

  @ApiProperty({ description: 'Stellar public address', example: 'GD5I3Q7IK...' })
  stellarAddress!: string;

  @ApiPropertyOptional({ description: 'Human-readable label' })
  label?: string;

  @ApiProperty({ enum: WalletType, description: 'Wallet type' })
  walletType!: WalletType;

  @ApiProperty({ enum: StellarNetwork, description: 'Stellar network' })
  network!: StellarNetwork;

  @ApiProperty({ enum: WalletStatus, description: 'Current wallet status' })
  status!: WalletStatus;

  @ApiProperty({ description: 'Wallet creation timestamp' })
  createdAt!: Date;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt!: Date;
}

export class WalletBalanceDto {
  @ApiProperty({ description: 'Asset code (e.g., XLM, USDC)', example: 'XLM' })
  asset!: string;

  @ApiProperty({ description: 'Balance amount', example: '100.0000000' })
  balance!: string;

  @ApiPropertyOptional({ description: 'Asset issuer address (null for native XLM)' })
  issuer?: string;
}
