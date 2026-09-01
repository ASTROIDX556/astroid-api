import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StellarNetwork, WalletType } from '@prisma/client';
import { stellarAddressSchema } from '../../common/validators/stellar-address.schema';

/**
 * Create a wallet. Two modes:
 *  - generate (default): the server mints a fresh Stellar keypair; the secret is
 *    returned to the caller EXACTLY ONCE and never stored (non-custodial).
 *  - import: the caller supplies an existing public `stellarAddress` to track.
 */
export const createWalletSchema = z
  .object({
    label: z.string().max(120).optional(),
    walletType: z.nativeEnum(WalletType).default(WalletType.AGENT),
    network: z.nativeEnum(StellarNetwork).default(StellarNetwork.TESTNET),
    agentId: z.string().uuid().optional(),
    /** When provided, the wallet is imported (address-only) rather than generated. */
    stellarAddress: stellarAddressSchema.optional(),
  })
  .strict();
export type CreateWalletInput = z.infer<typeof createWalletSchema>;

export const updateWalletSchema = z
  .object({
    label: z.string().max(120).optional(),
    agentId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type UpdateWalletInput = z.infer<typeof updateWalletSchema>;

export const walletBalanceQuerySchema = z.object({}).strict();

// ── Swagger DTOs (documentation only; validation is done by Zod pipes) ──

export class CreateWalletDto {
  @ApiPropertyOptional({ example: 'Treasury – Operations' })
  label?: string;

  @ApiPropertyOptional({ enum: WalletType })
  walletType?: WalletType;

  @ApiPropertyOptional({ enum: StellarNetwork })
  network?: StellarNetwork;

  @ApiPropertyOptional({ description: 'Owning agent id (optional)' })
  agentId?: string;

  @ApiPropertyOptional({
    description: 'Import an existing address instead of generating a new keypair',
  })
  stellarAddress?: string;
}

export class UpdateWalletDto {
  @ApiPropertyOptional()
  label?: string;

  @ApiPropertyOptional({ nullable: true, description: 'Reassign or clear the owning agent' })
  agentId?: string | null;
}

export class WalletSecretDto {
  @ApiProperty({ description: 'Public Stellar address (G...)' })
  stellarAddress!: string;

  @ApiProperty({
    description:
      'The generated secret key (S...). Shown ONCE and never stored server-side. Persist it securely now.',
  })
  secretKey!: string;
}
