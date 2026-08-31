import { DomainException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';

/**
 * Thrown when an encryption operation fails.
 */
export class EncryptionException extends DomainException {
  constructor(message: string, cause?: unknown) {
    super(ErrorCode.INTERNAL_ERROR, message, {
      cause: cause instanceof Error ? cause.message : undefined,
    });
    this.name = 'EncryptionException';
  }
}

/**
 * Thrown when decryption fails due to corrupted ciphertext, altered auth tag, or invalid key.
 */
export class DecryptionException extends DomainException {
  constructor(
    message = 'Decryption failed: invalid ciphertext, altered authentication tag, or corrupted data',
    cause?: unknown,
  ) {
    super(ErrorCode.BAD_REQUEST, message, {
      cause: cause instanceof Error ? cause.message : undefined,
    });
    this.name = 'DecryptionException';
  }
}

/**
 * Thrown on application startup when the configured master key is missing or incorrectly sized.
 */
export class InvalidEncryptionKeyError extends DomainException {
  constructor(message = 'Invalid master encryption key: must be a 32-byte (256-bit) key') {
    super(ErrorCode.INTERNAL_ERROR, message);
    this.name = 'InvalidEncryptionKeyError';
  }
}
