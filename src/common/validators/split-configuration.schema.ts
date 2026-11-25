import { z } from 'zod';
import { ValidationException } from '../exceptions/domain.exception';
import { stellarPublicKeySchema } from './stellar-address.schema';
import { formatZodError } from './zod-error';

/**
 * Validation for payment-split configurations: a non-empty list of receivers,
 * each with a Stellar account address and an integer weight.
 *
 * Invalid splits (duplicate receivers, weight totals beyond the precision
 * limit, malformed addresses) are rejected *before* a split payload is built
 * so they can never reach the submission stage and revert on-chain.
 *
 * Performance note: every check below is synchronous, allocation-light and
 * O(n) in the number of receivers (one pass with a `Set` for duplicate
 * detection), so validation adds no measurable latency and never blocks the
 * event loop beyond trivial CPU work — no I/O, no async scheduling.
 */

/**
 * Maximum total weight accepted across all receivers.
 *
 * Weights are integers expressed relative to a whole allocation; the total
 * may not exceed 10^7 so a full split still maps exactly onto Stellar's
 * 7-decimal (stroop) precision when weights are converted to amounts.
 */
export const MAX_SPLIT_WEIGHT_TOTAL = 10_000_000;

/** One receiver of a payment split: an account address and its weight. */
export const splitReceiverSchema = z.object({
  /** Destination account — Ed25519 (G…) or multiplexed (M…). */
  address: stellarPublicKeySchema,
  weight: z
    .number({ invalid_type_error: 'Receiver weight must be a number' })
    .int('Receiver weight must be an integer')
    .positive('Receiver weight must be greater than zero')
    .max(
      MAX_SPLIT_WEIGHT_TOTAL,
      `Receiver weight cannot exceed the maximum precision limit of ${MAX_SPLIT_WEIGHT_TOTAL}`,
    ),
});

/** A validated payment split: at least one receiver, unique addresses, weights within the precision limit. */
export const splitConfigurationSchema = z
  .array(splitReceiverSchema)
  .min(1, 'A split configuration must include at least one receiver')
  .superRefine((receivers, ctx) => {
    // Duplicate receivers would double-pay an address or silently drop funds.
    const seen = new Set<string>();
    receivers.forEach((receiver, index) => {
      if (seen.has(receiver.address)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'address'],
          message: `Duplicate receiver address '${receiver.address}' — each receiver may appear only once`,
        });
      }
      seen.add(receiver.address);
    });

    const totalWeight = receivers.reduce((sum, receiver) => sum + receiver.weight, 0);
    if (totalWeight > MAX_SPLIT_WEIGHT_TOTAL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `Split weight total ${totalWeight} exceeds the maximum precision limit of ${MAX_SPLIT_WEIGHT_TOTAL}`,
      });
    }
  });

export type SplitReceiver = z.infer<typeof splitReceiverSchema>;
export type SplitConfiguration = z.infer<typeof splitConfigurationSchema>;

/**
 * Validates a split configuration and returns it typed, or throws a
 * descriptive {@link ValidationException} carrying the structured
 * `ValidationErrorDetail[]` for every failed rule.
 *
 * Call this before building a split payload so malformed configurations fail
 * fast with an actionable message instead of surfacing as on-chain reverts.
 *
 * @throws ValidationException when the input violates any split constraint.
 */
export function validateSplitConfiguration(input: unknown): SplitConfiguration {
  const result = splitConfigurationSchema.safeParse(input);
  if (!result.success) {
    const details = formatZodError(result.error);
    const summary = details.map((detail) => detail.message).join('; ');
    throw new ValidationException(`Invalid split configuration: ${summary}`, details);
  }
  return result.data;
}
