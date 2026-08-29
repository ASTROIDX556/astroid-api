import { StrKey } from '@stellar/stellar-sdk';
import { ValidationException } from '../../common/exceptions/domain.exception';

/**
 * Validates Stellar addresses and memo formats before they reach the blockchain.
 * This prevents invalid transactions from costing network resources and provides
 * clear error messages instead of generic failures.
 */
export class TransactionsValidator {
  /**
   * Validates a Stellar public key address.
   * Supports both standard Ed25519 public keys (G...) and multiplexed addresses (M...).
   */
  static validateStellarAddress(address: string): void {
    if (!address || typeof address !== 'string') {
      throw new ValidationException('Stellar address is required');
    }

    // Check for standard Ed25519 public key (G...)
    if (address.startsWith('G')) {
      if (!StrKey.isValidEd25519PublicKey(address)) {
        throw new ValidationException(
          `Invalid Stellar Ed25519 public key: '${address}'. Must be a valid G-prefixed address.`,
        );
      }
      return;
    }

    // Check for multiplexed address (M...)
    if (address.startsWith('M')) {
      if (!StrKey.isValidMed25519PublicKey(address)) {
        throw new ValidationException(
          `Invalid Stellar multiplexed address: '${address}'. Must be a valid M-prefixed address.`,
        );
      }
      return;
    }

    // If it doesn't start with G or M, it's invalid
    throw new ValidationException(
      `Invalid Stellar address format: '${address}'. Must start with 'G' (Ed25519) or 'M' (multiplexed).`,
    );
  }

  /**
   * Validates a memo according to Stellar specifications.
   * Stellar supports 4 memo types: Text, Id, Hash, Return.
   * For simplicity in this API, we primarily support Text memos with proper length validation.
   */
  static validateMemo(memo?: string): void {
    if (!memo) {
      return; // Memos are optional
    }

    if (typeof memo !== 'string') {
      throw new ValidationException('Memo must be a string');
    }

    // Stellar MemoText has a maximum length of 28 bytes
    const byteLength = new Blob([memo]).size;
    if (byteLength > 28) {
      throw new ValidationException(
        `Memo exceeds maximum length of 28 bytes. Current length: ${byteLength} bytes`,
      );
    }

    // Check for empty memo after trimming
    if (memo.trim().length === 0) {
      throw new ValidationException('Memo cannot be empty or whitespace only');
    }

    // Validate that the memo contains only printable ASCII characters
    // Stellar memos should be ASCII for broad compatibility
    if (!/^[\x20-\x7E]*$/.test(memo)) {
      throw new ValidationException(
        'Memo contains invalid characters. Only printable ASCII characters are allowed',
      );
    }
  }

  /**
   * Validates a memo hash (for Hash or Return memo types).
   * Must be a 32-byte hex string (64 hex characters).
   */
  static validateMemoHash(memoHash?: string): void {
    if (!memoHash) {
      return; // Optional
    }

    if (typeof memoHash !== 'string') {
      throw new ValidationException('Memo hash must be a string');
    }

    // Stellar memo hashes must be exactly 32 bytes (64 hex characters)
    if (memoHash.length !== 64) {
      throw new ValidationException(
        `Memo hash must be exactly 64 hex characters (32 bytes). Received: ${memoHash.length} characters`,
      );
    }

    // Must be valid hexadecimal
    if (!/^[0-9a-fA-F]{64}$/.test(memoHash)) {
      throw new ValidationException('Memo hash must be a valid 32-byte hexadecimal string');
    }
  }

  /**
   * Validates a memo ID (for Id memo type).
   * Must be a 64-bit unsigned integer.
   */
  static validateMemoId(memoId?: string | number): void {
    if (memoId === undefined || memoId === null) {
      return; // Optional
    }

    const id = typeof memoId === 'string' ? parseInt(memoId, 10) : memoId;

    if (isNaN(id)) {
      throw new ValidationException('Memo ID must be a valid number');
    }

    // Stellar memo IDs are 64-bit unsigned integers
    if (id < 0 || id > Number.MAX_SAFE_INTEGER) {
      throw new ValidationException(
        `Memo ID must be a positive 64-bit integer. Received: ${id}`,
      );
    }
  }

  /**
   * Comprehensive validation for transaction input including address and memo.
   */
  static validateTransactionInput(
    recipientAddress: string,
    memo?: string,
  ): void {
    this.validateStellarAddress(recipientAddress);
    this.validateMemo(memo);
  }
}