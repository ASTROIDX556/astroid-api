import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { stellarMemoTypeSchema } from '../../common/validators/stellar-memo.schema';
import { stellarPublicKeySchema } from '../../common/validators/stellar-address.schema';
import { stellarAssetSchema } from '../../common/validators/stellar-asset.schema';
import { ValidationException } from '../../common/exceptions/domain.exception';

const idempotencyKeyPattern = /^[A-Za-z0-9._~-]{1,128}$/;

export function parseIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !idempotencyKeyPattern.test(value)) {
    throw new ValidationException(
      'Idempotency-Key must contain 1 to 128 ASCII letters, digits, dots, underscores, tildes, or hyphens',
    );
  }
  return value;
}

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

const amountString = z
  .string()
  .regex(/^\d+(\.\d{1,7})?$/, 'Amount must be a positive decimal with up to 7 places')
  .refine((v) => Number(v) > 0, 'Amount must be greater than zero');

const assetTransferSchema = z.object({
  asset: stellarAssetSchema,
  amount: amountString,
  recipientAddress: stellarPublicKeySchema.optional(),
});

export const createTransactionSchema = z
  .object({
    walletId: z.string().uuid(),
    agentId: z.string().uuid().optional(),
    budgetId: z.string().uuid().optional(),
    asset: stellarAssetSchema.default('XLM'),
    amount: amountString,
    recipientAddress: stellarPublicKeySchema,
    transfers: z.array(assetTransferSchema).max(10).optional(),
    memo: z.string().max(128).optional(),
    memoType: stellarMemoTypeSchema.optional(),
    memoValue: z.string().optional(),
    purpose: z.string().max(280).optional(),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.transfers) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A transaction moves a single asset; use the simulation endpoint for multi-asset transfers',
        path: ['transfers'],
      });
      return;
    }
    const hasTyped = data.memoType !== undefined;
    const hasLegacy = data.memo !== undefined;

    if (!hasTyped && !hasLegacy) return;

    if (hasTyped && !data.memoValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'memoValue is required when memoType is specified',
        path: ['memoValue'],
      });
      return;
    }

    if (!hasTyped && hasLegacy) {
      const byteLength = new TextEncoder().encode(data.memo!).byteLength;
      if (byteLength === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Memo cannot be empty',
          path: ['memo'],
        });
      } else if (byteLength > 28) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Memo exceeds maximum length of 28 bytes (got ${byteLength} bytes)`,
          path: ['memo'],
        });
      }
      return;
    }

    if (hasTyped && data.memoValue !== undefined) {
      switch (data.memoType) {
        case 'text': {
          const byteLength = new TextEncoder().encode(data.memoValue).byteLength;
          if (byteLength === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Text memo cannot be empty',
              path: ['memoValue'],
            });
          } else if (byteLength > 28) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Text memo exceeds maximum length of 28 bytes (got ${byteLength} bytes)`,
              path: ['memoValue'],
            });
          }
          break;
        }
        case 'id': {
          if (!/^\d+$/.test(data.memoValue)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Memo ID must be a non-negative integer string',
              path: ['memoValue'],
            });
          } else {
            try {
              const big = BigInt(data.memoValue);
              if (big < BigInt(0) || big > BigInt('18446744073709551615')) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: 'Memo ID must be in range 0 to 18446744073709551615',
                  path: ['memoValue'],
                });
              }
            } catch {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Memo ID is not a valid unsigned 64-bit integer',
                path: ['memoValue'],
              });
            }
          }
          break;
        }
        case 'hash':
        case 'return': {
          if (!/^[0-9a-fA-F]{64}$/.test(data.memoValue)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${data.memoType === 'hash' ? 'Hash' : 'Return'} memo must be exactly 64 hex characters (32 bytes)`,
              path: ['memoValue'],
            });
          }
          break;
        }
      }
    }
  });

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

export const simulateTransactionSchema = z
  .object({
    walletId: z.string().uuid(),
    agentId: z.string().uuid().optional(),
    budgetId: z.string().uuid().optional(),
    asset: stellarAssetSchema.optional(),
    amount: amountString.optional(),
    recipientAddress: stellarPublicKeySchema,
    transfers: z.array(assetTransferSchema).min(1).max(10).optional(),
    memo: z.string().max(128).optional(),
    memoType: stellarMemoTypeSchema.optional(),
    memoValue: z.string().optional(),
    purpose: z.string().max(280).optional(),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasTransfers = data.transfers !== undefined;
    const hasSingle = data.asset !== undefined || data.amount !== undefined;
    if (hasTransfers && hasSingle) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide either an asset/amount pair or transfers, not both', path: ['transfers'] });
    } else if (!hasTransfers && data.amount === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amount is required when transfers is not provided', path: ['amount'] });
    }
  });
export type SimulateTransactionInput = z.infer<typeof simulateTransactionSchema>;

// ── Swagger DTOs ──

export class CreateTransactionDto {
  @ApiProperty({ description: 'Sender wallet UUID', format: 'uuid', example: '018f0a1b-1234-7000-8000-000000000001' })
  walletId!: string;

  @ApiPropertyOptional({ description: 'Initiating agent UUID', format: 'uuid' })
  agentId?: string;

  @ApiPropertyOptional({ description: 'Budget UUID to charge this transaction against', format: 'uuid' })
  budgetId?: string;

  @ApiPropertyOptional({ example: 'XLM', description: 'Asset to transfer' })
  asset?: string;

  @ApiProperty({ example: '125.5000000', description: 'Amount to transfer, with up to 7 decimals' })
  amount!: string;

  @ApiProperty({ example: 'GB...', description: 'Stellar address the funds are sent to' })
  recipientAddress!: string;

  @ApiPropertyOptional({
    description: 'Memo text (legacy format, max 28 bytes UTF-8)',
    maxLength: 28,
  })
  memo?: string;

  @ApiPropertyOptional({
    description: 'Stellar memo type: text, id, hash, or return',
    enum: ['text', 'id', 'hash', 'return'],
  })
  memoType?: 'text' | 'id' | 'hash' | 'return';

  @ApiPropertyOptional({
    description: 'Memo value for typed memos (required when memoType is specified)',
  })
  memoValue?: string;

  @ApiPropertyOptional({ description: 'Human-readable purpose of the payment', example: 'Q3 cloud infrastructure invoice' })
  purpose?: string;

  @ApiPropertyOptional({ type: Object, description: 'Free-form metadata stored with the transaction' })
  metadata?: Record<string, unknown>;
}

/** A transaction as returned by the API. */
export class TransactionResponseDto {
  @ApiProperty({ description: 'Transaction id', example: '018f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b' })
  id!: string;

  @ApiProperty({ description: 'Wallet that sends the funds', example: '018f0a1b-1111-4a5b-8c9d-0e1f2a3b4c5d' })
  walletId!: string;

  @ApiPropertyOptional({ description: 'Agent that initiated the transaction' })
  agentId?: string;

  @ApiProperty({ description: 'Asset transferred', example: 'USDC' })
  asset!: string;

  @ApiProperty({ description: 'Transferred amount', example: '125.5000000' })
  amount!: string;

  @ApiProperty({ description: 'Destination Stellar address' })
  recipientAddress!: string;

  @ApiPropertyOptional({ description: 'Memo attached to the payment' })
  memo?: string;

  @ApiPropertyOptional({ description: 'Human-readable purpose of the payment' })
  purpose?: string;

  @ApiProperty({
    description: 'Lifecycle status of the transaction',
    enum: ['DRAFT', 'PENDING', 'APPROVED', 'SUBMITTED', 'CONFIRMED', 'COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  })
  status!: string;

  @ApiProperty({ description: 'Composite risk score between 0 and 100', example: 24 })
  riskScore!: number;

  @ApiProperty({
    description: 'Risk band derived from the score',
    enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
  })
  riskBand!: string;

  @ApiProperty({ description: 'Whether the transaction needs a human approval before execution' })
  requiresApproval!: boolean;

  @ApiPropertyOptional({ description: 'Stellar transaction hash once the payment was submitted' })
  stellarHash?: string;

  @ApiPropertyOptional({ description: 'Number of ledger confirmations received' })
  confirmationCount?: number;

  @ApiProperty({ description: 'Creation timestamp', example: '2026-01-15T10:30:00.000Z' })
  createdAt!: string;
}

/** The risk assessment of a transaction. */
export class TransactionRiskDto {
  @ApiProperty({ description: 'Composite risk score between 0 and 100', example: 24 })
  score!: number;

  @ApiProperty({ description: 'Risk band derived from the score', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] })
  band!: string;

  @ApiProperty({ description: 'Whether the transaction may execute without a human approval' })
  canAutoExecute!: boolean;

  @ApiProperty({ description: 'Whether the transaction requires a human approval' })
  requiresApproval!: boolean;
}

/** The approval proposal raised for a transaction that needs a sign-off. */
export class ProposalResponseDto {
  @ApiProperty({ description: 'Proposal id', example: '018f0a1b-3333-4a5b-8c9d-0e1f2a3b4c5d' })
  id!: string;

  @ApiProperty({ description: 'Transaction the proposal approves', example: '018f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b' })
  transactionId!: string;

  @ApiProperty({ description: 'Title shown to the reviewers' })
  title!: string;

  @ApiProperty({ description: 'Number of approvals required before the transaction executes', example: 2 })
  requiredApprovals!: number;

  @ApiProperty({
    description: 'Proposal status',
    enum: ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'CANCELLED'],
  })
  status!: string;

  @ApiPropertyOptional({ description: 'Moment the proposal expires' })
  expiresAt?: string;
}

/** The result of a transaction submission. */
export class TransactionSubmissionDto {
  @ApiProperty({ type: TransactionResponseDto, description: 'The persisted transaction' })
  transaction!: TransactionResponseDto;

  @ApiProperty({ description: 'Whether the transaction waits for a human approval' })
  requiresApproval!: boolean;

  @ApiPropertyOptional({
    type: ProposalResponseDto,
    description: 'Approval proposal, present when the transaction needs a sign-off',
  })
  proposal?: ProposalResponseDto;

  @ApiPropertyOptional({ type: TransactionRiskDto, description: 'Risk assessment the decision was based on' })
  risk?: TransactionRiskDto;
}

/** The outcome of a governance simulation. */
export class TransactionSimulationDto {
  @ApiProperty({ description: 'Whether the transaction would pass every policy' })
  wouldPass!: boolean;

  @ApiProperty({ description: 'Whether the transaction would require a human approval' })
  requiresApproval!: boolean;

  @ApiProperty({ type: TransactionRiskDto, description: 'Risk assessment of the hypothetical transaction' })
  risk!: TransactionRiskDto;
}
