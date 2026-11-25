import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto';
import {
  EncryptedBufferData,
  EncryptedData,
  EncryptionOptions,
} from './encryption.interface';
import {
  DecryptionException,
  EncryptionException,
  InvalidEncryptionKeyError,
} from './encryption.errors';
import { EncryptionConfig } from '../../config/encryption.config';

/**
 * Standard sensitive secret field names that must be encrypted before persistence.
 */
export const SENSITIVE_SECRET_FIELDS = new Set([
  'privatekey',
  'private_key',
  'secret',
  'secretkey',
  'secret_key',
  'apikey',
  'api_key',
  'credentials',
  'seed',
  'signingkey',
  'signing_key',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'webhooksecret',
  'webhook_secret',
  'clientsecret',
  'client_secret',
  'password',
  'passwordhash',
]);

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits standard for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const ENCRYPTED_PREFIX = 'enc:v1';

/**
 * Cryptographic Encryption-at-Rest Service utilizing AES-256-GCM.
 *
 * Provides authenticated encryption with unique initialization vectors (IVs)
 * and authentication tags for every encryption operation to protect sensitive
 * agent private keys, API secrets, and credentials in the database.
 */
@Injectable()
export class EncryptionService implements OnModuleInit {
  private masterKey!: Buffer;

  constructor(@Optional() private readonly configService?: ConfigService) {
    this.initializeKey();
  }

  onModuleInit(): void {
    // Re-verify that master key is valid on startup to fail fast
    if (!this.masterKey || this.masterKey.length !== 32) {
      throw new InvalidEncryptionKeyError(
        'Master encryption key validation failed on startup: key must be exactly 32 bytes (256 bits)',
      );
    }
  }

  /**
   * Initializes and validates the master encryption key from ConfigService or environment.
   */
  private initializeKey(): void {
    let rawKey: string | undefined;

    if (this.configService) {
      const encConfig = this.configService.get<EncryptionConfig>('encryption');
      rawKey = encConfig?.key ?? this.configService.get<string>('ENCRYPTION_KEY');
    }

    if (!rawKey && typeof process !== 'undefined' && process.env) {
      rawKey = process.env.ENCRYPTION_KEY ?? process.env.ENCRYPTION_MASTER_KEY;
    }

    if (!rawKey) {
      // Default fallback key for test/dev environment if not explicitly set
      rawKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    }

    this.masterKey = this.validateAndDeriveKey(rawKey);
  }

  /**
   * Validates and derives a 32-byte Buffer key from a raw string or Buffer.
   * Throws `InvalidEncryptionKeyError` without leaking key material if invalid.
   */
  validateAndDeriveKey(keyInput?: string | Buffer): Buffer {
    if (!keyInput) {
      throw new InvalidEncryptionKeyError('Master encryption key is missing or undefined');
    }

    if (Buffer.isBuffer(keyInput)) {
      if (keyInput.length !== 32) {
        throw new InvalidEncryptionKeyError(
          `Invalid encryption key length: expected 32 bytes, got ${keyInput.length} bytes`,
        );
      }
      return keyInput;
    }

    if (typeof keyInput !== 'string' || keyInput.trim() === '') {
      throw new InvalidEncryptionKeyError('Master encryption key must be a non-empty string or Buffer');
    }

    const trimmed = keyInput.trim();

    // 1. Hex encoded (64 hex characters = 32 bytes)
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return Buffer.from(trimmed, 'hex');
    }

    // 2. Base64 encoded
    try {
      const base64Buf = Buffer.from(trimmed, 'base64');
      if (base64Buf.length === 32 && (trimmed.length === 43 || trimmed.length === 44)) {
        return base64Buf;
      }
    } catch {
      // ignore and continue
    }

    // 3. Raw 32-byte UTF-8 string
    if (Buffer.byteLength(trimmed, 'utf8') === 32) {
      return Buffer.from(trimmed, 'utf8');
    }

    throw new InvalidEncryptionKeyError(
      'Invalid master encryption key: must be 64 hex characters or 32 raw bytes',
    );
  }

  /**
   * Resolves the key to use (custom key override or master key).
   */
  private resolveKey(options?: EncryptionOptions | string | Buffer): {
    key: Buffer;
    aad?: Buffer;
  } {
    if (!options) {
      return { key: this.masterKey };
    }

    if (typeof options === 'string' || Buffer.isBuffer(options)) {
      return {
        key: this.masterKey,
        aad: typeof options === 'string' ? Buffer.from(options, 'utf8') : options,
      };
    }

    const key = options.key ? this.validateAndDeriveKey(options.key) : this.masterKey;
    const aad = options.aad
      ? typeof options.aad === 'string'
        ? Buffer.from(options.aad, 'utf8')
        : options.aad
      : undefined;

    return { key, aad };
  }

  /**
   * Encrypts plaintext buffer using AES-256-GCM with a unique 96-bit IV.
   */
  encryptBuffer(plaintext: Buffer, options?: EncryptionOptions): EncryptedBufferData {
    try {
      const { key, aad } = this.resolveKey(options);
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

      if (aad) {
        cipher.setAAD(aad);
      }

      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return { iv, authTag, ciphertext };
    } catch (error) {
      if (error instanceof InvalidEncryptionKeyError) {
        throw error;
      }
      throw new EncryptionException('Encryption operation failed', error);
    }
  }

  /**
   * Decrypts an EncryptedBufferData structure using AES-256-GCM.
   */
  decryptBuffer(encrypted: EncryptedBufferData, options?: EncryptionOptions): Buffer {
    try {
      const { key, aad } = this.resolveKey(options);

      if (!encrypted.iv || encrypted.iv.length !== IV_LENGTH) {
        throw new DecryptionException(
          `Invalid IV length: expected ${IV_LENGTH} bytes, got ${encrypted.iv?.length ?? 0}`,
        );
      }
      if (!encrypted.authTag || encrypted.authTag.length !== AUTH_TAG_LENGTH) {
        throw new DecryptionException(
          `Invalid auth tag length: expected ${AUTH_TAG_LENGTH} bytes, got ${encrypted.authTag?.length ?? 0}`,
        );
      }

      const decipher = createDecipheriv(ALGORITHM, key, encrypted.iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });

      decipher.setAuthTag(encrypted.authTag);

      if (aad) {
        decipher.setAAD(aad);
      }

      return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
    } catch (error) {
      if (error instanceof DecryptionException || error instanceof InvalidEncryptionKeyError) {
        throw error;
      }
      throw new DecryptionException(
        'Decryption failed: authentication tag verification failed or corrupted ciphertext',
        error,
      );
    }
  }

  /**
   * Encrypts a string or Buffer and returns an encapsulated serialized string:
   * `enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>`
   */
  encrypt(plaintext: string | Buffer, options?: EncryptionOptions | string | Buffer): string {
    const buffer = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const opts: EncryptionOptions | undefined =
      typeof options === 'string' || Buffer.isBuffer(options)
        ? { aad: options }
        : options;

    const { iv, authTag, ciphertext } = this.encryptBuffer(buffer, opts);
    return this.serialize({
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      ciphertext: ciphertext.toString('hex'),
      algorithm: ALGORITHM,
      version: 'v1',
    });
  }

  /**
   * Decrypts an encapsulated serialized string or EncryptedData object to plaintext string.
   */
  decrypt(
    encryptedPayload: string | EncryptedData,
    options?: EncryptionOptions | string | Buffer,
  ): string {
    const opts: EncryptionOptions | undefined =
      typeof options === 'string' || Buffer.isBuffer(options)
        ? { aad: options }
        : options;

    const parsed =
      typeof encryptedPayload === 'string'
        ? this.deserialize(encryptedPayload)
        : encryptedPayload;

    const encryptedBuffer: EncryptedBufferData = {
      iv: Buffer.from(parsed.iv, 'hex'),
      authTag: Buffer.from(parsed.authTag, 'hex'),
      ciphertext: Buffer.from(parsed.ciphertext, 'hex'),
    };

    const decrypted = this.decryptBuffer(encryptedBuffer, opts);
    return decrypted.toString('utf8');
  }

  /**
   * Encrypts a JSON-serializable object into an encapsulated ciphertext string.
   */
  encryptObject<T = Record<string, unknown>>(data: T, options?: EncryptionOptions): string {
    const jsonString = JSON.stringify(data);
    return this.encrypt(jsonString, options);
  }

  /**
   * Decrypts an encapsulated ciphertext string and parses the result as JSON.
   */
  decryptObject<T = Record<string, unknown>>(
    encryptedPayload: string | EncryptedData,
    options?: EncryptionOptions,
  ): T {
    const decryptedString = this.decrypt(encryptedPayload, options);
    try {
      return JSON.parse(decryptedString) as T;
    } catch (error) {
      throw new DecryptionException('Failed to parse decrypted payload as JSON', error);
    }
  }

  /**
   * Serializes structured EncryptedData into an encapsulated string.
   */
  serialize(data: EncryptedData): string {
    return `${ENCRYPTED_PREFIX}:${data.iv}:${data.authTag}:${data.ciphertext}`;
  }

  /**
   * Deserializes an encapsulated string or formatted payload into EncryptedData.
   */
  deserialize(serialized: string): EncryptedData {
    if (typeof serialized !== 'string' || serialized.trim() === '') {
      throw new DecryptionException('Encrypted payload must be a non-empty string');
    }

    const parts = serialized.trim().split(':');

    // Format 1: enc:v1:iv:authTag:ciphertext (5 parts)
    if (parts.length === 5 && parts[0] === 'enc' && parts[1] === 'v1') {
      return {
        version: parts[1],
        iv: parts[2],
        authTag: parts[3],
        ciphertext: parts[4],
        algorithm: ALGORITHM,
      };
    }

    // Format 2: v1:iv:authTag:ciphertext (4 parts)
    if (parts.length === 4 && parts[0] === 'v1') {
      return {
        version: parts[0],
        iv: parts[1],
        authTag: parts[2],
        ciphertext: parts[3],
        algorithm: ALGORITHM,
      };
    }

    // Format 3: iv:authTag:ciphertext (3 parts)
    if (parts.length === 3) {
      return {
        iv: parts[0],
        authTag: parts[1],
        ciphertext: parts[2],
        algorithm: ALGORITHM,
      };
    }

    // Format 4: JSON string representation
    if (serialized.startsWith('{') && serialized.endsWith('}')) {
      try {
        const obj = JSON.parse(serialized) as Record<string, unknown>;
        if (typeof obj.iv === 'string' && typeof obj.ciphertext === 'string') {
          const authTag = (obj.authTag ?? obj.tag) as string;
          if (typeof authTag === 'string') {
            return {
              iv: obj.iv,
              authTag,
              ciphertext: obj.ciphertext,
              algorithm: (obj.algorithm as string) ?? ALGORITHM,
              version: (obj.version as string) ?? 'v1',
            };
          }
        }
      } catch {
        // continue to throw
      }
    }

    throw new DecryptionException('Malformed encrypted payload format');
  }

  /**
   * Checks whether a given value is already in the encrypted format.
   */
  isEncrypted(value: unknown): boolean {
    if (typeof value !== 'string') {
      if (
        value &&
        typeof value === 'object' &&
        'iv' in value &&
        ('authTag' in value || 'tag' in value) &&
        'ciphertext' in value
      ) {
        return true;
      }
      return false;
    }

    if (value.startsWith(ENCRYPTED_PREFIX)) {
      return true;
    }

    // Check colon format: iv (24 hex) : tag (32 hex) : ciphertext (hex)
    const parts = value.split(':');
    if (parts.length === 3) {
      return /^[0-9a-fA-F]{24}$/.test(parts[0]) && /^[0-9a-fA-F]{32}$/.test(parts[1]);
    }
    if (parts.length === 4 && parts[0] === 'v1') {
      return /^[0-9a-fA-F]{24}$/.test(parts[1]) && /^[0-9a-fA-F]{32}$/.test(parts[2]);
    }

    return false;
  }

  /**
   * Recursively traverses an object/array and encrypts or decrypts sensitive secret fields.
   *
   * In 'encrypt' mode: plaintext secrets are replaced with encrypted tokens.
   * In 'decrypt' mode: encrypted tokens are decrypted back to their original values.
   */
  transformSensitiveFields<T>(
    data: T,
    mode: 'encrypt' | 'decrypt',
    customFields?: string[],
  ): T {
    if (data === null || data === undefined) {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) =>
        this.transformSensitiveFields(item, mode, customFields),
      ) as unknown as T;
    }

    if (typeof data === 'object') {
      const fieldSet = customFields
        ? new Set(customFields.map((f) => f.toLowerCase()))
        : SENSITIVE_SECRET_FIELDS;

      const result: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        const isSensitiveKey = fieldSet.has(key.toLowerCase());

        if (isSensitiveKey && value !== null && value !== undefined) {
          if (mode === 'encrypt') {
            if (typeof value === 'string') {
              result[key] = this.isEncrypted(value) ? value : this.encrypt(value);
            } else if (typeof value === 'object') {
              result[key] = this.encryptObject(value);
            } else {
              result[key] = this.encrypt(String(value));
            }
          } else {
            // mode === 'decrypt'
            if (typeof value === 'string' && this.isEncrypted(value)) {
              try {
                const decrypted = this.decrypt(value);
                try {
                  // If original value was serialized JSON object, parse it
                  result[key] = JSON.parse(decrypted);
                } catch {
                  result[key] = decrypted;
                }
              } catch {
                result[key] = value;
              }
            } else {
              result[key] = this.transformSensitiveFields(value, mode, customFields);
            }
          }
        } else {
          result[key] = this.transformSensitiveFields(value, mode, customFields);
        }
      }

      return result as T;
    }

    return data;
  }
}
