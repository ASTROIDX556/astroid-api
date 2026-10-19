import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  stellarContractIdSchema,
  stellarEd25519PublicKeySchema,
} from '../../../common/validators/stellar-address.schema';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

/**
 * Zod schema for Soroban contract invocation parameters.
 * Validates contract ID format, function name, and argument structure.
 */
export const sorobanInvocationSchema = z
  .object({
    contractId: stellarContractIdSchema,
    functionName: z
      .string()
      .min(1, 'Function name is required')
      .max(256)
      .regex(/^[a-zA-Z0-9_]+$/, 'Function name must contain only alphanumeric characters and underscores'),
    args: z.array(jsonValueSchema).max(100, 'A Soroban invocation cannot contain more than 100 arguments').default([]),
    feeLimit: z
      .number()
      .int()
      .positive()
      .max(100000000, 'Fee limit cannot exceed 100,000,000 stroops')
      .optional(),
    auth: z
      .object({
        sourceAccount: stellarEd25519PublicKeySchema.optional(),
        signature: z.string().min(1).max(1024).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SorobanInvocationInput = z.infer<typeof sorobanInvocationSchema>;

/**
 * Zod schema for Soroban transaction submission.
 * Validates the XDR envelope format and associated metadata.
 */
export const sorobanTransactionSchema = z
  .object({
    xdr: z
      .string()
      .min(1, 'XDR envelope is required')
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
        'XDR must be valid base64',
      )
      .refine((value) => Buffer.from(value, 'base64').length > 0, 'XDR envelope cannot be empty'),
    network: z.enum(['TESTNET', 'PUBLIC', 'FUTURENET']).optional(),
    skipSimulation: z.boolean().optional(),
  })
  .strict();

export type SorobanTransactionInput = z.infer<typeof sorobanTransactionSchema>;

// ── Swagger DTOs (documentation only; validation is done by Zod pipes) ──

export class SorobanInvocationDto {
  @ApiProperty({
    description: 'Soroban contract ID (56-character Stellar C-address with a valid checksum)',
    example: 'CDL3VCZ3R7J6HWAUKT4YJAQFJMXDZ25XSX2NZBY5LXYYZVP7KTCOHN7I',
  })
  contractId!: string;

  @ApiProperty({
    description: 'Contract function name to invoke',
    example: 'transfer',
  })
  functionName!: string;

  @ApiPropertyOptional({
    description: 'Function arguments (SCVal array)',
    type: [Object],
    example: [],
  })
  args?: unknown[];

  @ApiPropertyOptional({
    description: 'Maximum fee in stroops (1 stroop = 0.0000001 XLM)',
    example: 100000,
  })
  feeLimit?: number;

  @ApiPropertyOptional({
    description: 'Authentication parameters for the transaction',
    type: Object,
  })
  auth?: {
    sourceAccount?: string;
    signature?: string;
  };
}

export class SorobanTransactionDto {
  @ApiProperty({
    description: 'Base64-encoded Soroban transaction envelope XDR',
    example: 'AAAAAgAAA...',
  })
  xdr!: string;

  @ApiPropertyOptional({
    description: 'Stellar network to submit to',
    enum: ['TESTNET', 'PUBLIC', 'FUTURENET'],
  })
  network?: 'TESTNET' | 'PUBLIC' | 'FUTURENET';

  @ApiPropertyOptional({
    description: 'Skip transaction simulation (not recommended)',
  })
  skipSimulation?: boolean;
}

export class SorobanResponseDto {
  @ApiProperty({
    description: 'Transaction execution result',
    example: { status: 'success', returnValue: '...' },
  })
  result!: unknown;

  @ApiProperty({
    description: 'Transaction hash (if submitted)',
    example: 'a1b2c3d4...',
  })
  hash?: string;

  @ApiProperty({
    description: 'Fee charged in stroops',
    example: 5000,
  })
  feeCharged?: number;
}
