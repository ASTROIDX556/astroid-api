import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { stellarMemoTypeSchema } from '../../common/validators/stellar-memo.schema';
import { stellarAddressSchema } from '../../common/validators/stellar-address.schema';
import { stellarAssetSchema } from '../../common/validators/stellar-asset.schema';
import { ValidationException } from '../../common/exceptions/domain.exception';
import { assetTransferSchema } from '../policies/transfer-payload';

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

/** Fields shared by the create and simulate transaction payloads. */
const transactionPayloadFields = {
  walletId: z.string().uuid(),
  agentId: z.string().uuid().optional(),
  budgetId: z.string().uuid().optional(),
  recipientAddress: stellarAddressSchema,
  memo: z.string().max(128).optional(),
  memoType: stellarMemoTypeSchema.optional(),
  memoValue: z.string().optional(),
  purpose: z.string().max(280).optional(),
  metadata: z.record(jsonValueSchema).default({}),
};

/**
 * Validates the memo rules shared by the create and simulate payloads: a
 * typed memo requires a value, the value must fit the memo type and legacy
 * text memos are limited to 28 bytes.
 */
function validateMemo(
  data: { memo?: string; memoType?: string; memoValue?: string },
  ctx: z.RefinementCtx,
): void {
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
            message: `Memo ${data.memoType} must be exactly 64 hex characters (32 bytes)`,
            path: ['memoValue'],
          });
        }
        break;
      }
    }
  }
}

/**
 * Payload of `POST /transactions`. A transaction moves a single asset, so
 * exactly one `asset`/`amount` pair is accepted. Multi-asset payloads are
 * evaluated by the policy engine through the simulation endpoints.
 */
export const createTransactionSchema = z
  .object({
    ...transactionPayloadFields,
    asset: stellarAssetSchema.default('XLM'),
    amount: amountString,
    transfers: z.array(assetTransferSchema).max(10).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.transfers) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'A transaction moves a single asset. Submit one request per asset, or use POST /transactions/simulate to evaluate a multi-asset transfer against the spending policies.',
        path: ['transfers'],
      });
      return;
    }
    validateMemo(data, ctx);
  });

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

/**
 * Payload of `POST /transactions/simulate`. Accepts either a single-asset
 * `asset`/`amount` pair or a multi-asset `transfers` array; the two forms are
 * mutually exclusive.
 */
export const simulateTransactionSchema = z
  .object({
    ...transactionPayloadFields,
    asset: stellarAssetSchema.optional(),
    amount: amountString.optional(),
    transfers: z.array(assetTransferSchema).min(1).max(10).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasTransfers = data.transfers !== undefined;
    const hasSingle = data.amount !== undefined || data.asset !== undefined;

    if (hasTransfers && hasSingle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either an asset/amount pair or a transfers array, not both',
        path: ['transfers'],
      });
      return;
    }

    if (!hasTransfers && data.amount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'amount is required when transfers is not provided',
        path: ['amount'],
      });
    }

    validateMemo(data, ctx);
  });

export type SimulateTransactionInput = z.infer<typeof simulateTransactionSchema>;

// ── Swagger DTOs ──

export class CreateTransactionDto {
  @ApiProperty({ description: 'Sender wallet id' })
  walletId!: string;

  @ApiPropertyOptional({ description: 'Initiating agent id' })
  agentId?: string;

  @ApiPropertyOptional({ description: 'Budget to charge this transaction against' })
  budgetId?: string;

  @ApiPropertyOptional({
    example: 'XLM',
    description:
      'Asset to transfer. Either a ticker (`XLM`, `USDC`) or the canonical `CODE:ISSUER` form of a credit asset.',
  })
  asset?: string;

  @ApiProperty({ example: '125.5000000' })
  amount!: string;

  @ApiProperty({ example: 'GB...' })
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

  @ApiPropertyOptional()
  purpose?: string;

  @ApiPropertyOptional({ type: Object })
  metadata?: Record<string, unknown>;
}

/** Swagger model for one leg of a multi-asset transfer payload. */
export class AssetTransferDto {
  @ApiProperty({ example: 'XLM', description: 'Asset code or `CODE:ISSUER` identifier' })
  asset!: string;

  @ApiProperty({ example: '125.5000000' })
  amount!: string;
}
