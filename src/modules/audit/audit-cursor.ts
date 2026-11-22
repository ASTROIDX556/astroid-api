import { ZodValidationException } from '../../common/pipes/zod-validation.pipe';
import {
  CursorPayload,
  decodeCursor,
  encodeCursor,
  isValidCursor,
} from '../../common/pagination/cursor-pagination';

/**
 * Opaque audit cursor: base64url of `{"v":1,"createdAt":<ISO 8601>,"id":<audit id>}`.
 * The `(createdAt, id)` tuple is the complete sort key, so a cursor remains
 * valid even when the row it points at has since been archived or deleted.
 */
export type AuditCursor = CursorPayload;

export function encodeAuditCursor(payload: AuditCursor): string {
  return encodeCursor(payload);
}

/** Decodes and validates a cursor, raising the standard 400 validation envelope. */
export function decodeAuditCursor(value: string): AuditCursor {
  try {
    return decodeCursor(value);
  } catch {
    throw new ZodValidationException('Invalid audit cursor', [
      { path: 'cursor', message: 'Invalid cursor' },
    ]);
  }
}

export function isValidAuditCursor(value: string): boolean {
  return isValidCursor(value);
}
