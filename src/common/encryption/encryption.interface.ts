/**
 * Structured encapsulation for AES-256-GCM encrypted data.
 */
export interface EncryptedData {
  /** Initialization vector (hex encoded, 12 bytes = 24 hex characters) */
  iv: string;
  /** Authentication tag (hex encoded, 16 bytes = 32 hex characters) */
  authTag: string;
  /** Ciphertext (hex encoded) */
  ciphertext: string;
  /** Encryption algorithm identifier (default: 'aes-256-gcm') */
  algorithm?: string;
  /** Version prefix for schema migration & algorithm rotation (default: 'v1') */
  version?: string;
}

/**
 * Raw binary buffer representation of encrypted data.
 */
export interface EncryptedBufferData {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/**
 * Options for encryption and decryption operations.
 */
export interface EncryptionOptions {
  /** Optional Additional Authenticated Data (AAD) for GCM integrity binding */
  aad?: string | Buffer;
  /** Custom key override (32 bytes Buffer or valid hex/base64/utf8 string) */
  key?: string | Buffer;
}
