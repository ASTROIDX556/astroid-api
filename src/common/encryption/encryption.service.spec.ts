import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { EncryptionService, SENSITIVE_SECRET_FIELDS } from './encryption.service';
import {
  DecryptionException,
  InvalidEncryptionKeyError,
} from './encryption.errors';

describe('EncryptionService', () => {
  const validHexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 32 bytes hex
  const validRawKey = '12345678901234567890123456789012'; // 32 bytes UTF-8
  const validBase64Key = Buffer.from(validHexKey, 'hex').toString('base64'); // 32 bytes base64

  let service: EncryptionService;

  beforeEach(() => {
    const mockConfigService = {
      get: (key: string) => {
        if (key === 'encryption') {
          return { key: validHexKey, algorithm: 'aes-256-gcm' };
        }
        if (key === 'ENCRYPTION_KEY') {
          return validHexKey;
        }
        return undefined;
      },
    } as unknown as ConfigService;

    service = new EncryptionService(mockConfigService);
    service.onModuleInit();
  });

  describe('Master Key Validation & Fail-Fast Startup', () => {
    it('should initialize successfully with a valid 64-character hex key', () => {
      expect(() => {
        const s = new EncryptionService({
          get: () => ({ key: validHexKey }),
        } as unknown as ConfigService);
        s.onModuleInit();
      }).not.toThrow();
    });

    it('should initialize successfully with a 32-byte raw UTF-8 key', () => {
      expect(() => {
        const s = new EncryptionService({
          get: () => ({ key: validRawKey }),
        } as unknown as ConfigService);
        s.onModuleInit();
      }).not.toThrow();
    });

    it('should initialize successfully with a 32-byte base64 key', () => {
      expect(() => {
        const s = new EncryptionService({
          get: () => ({ key: validBase64Key }),
        } as unknown as ConfigService);
        s.onModuleInit();
      }).not.toThrow();
    });

    it('should accept a 32-byte Buffer key in validateAndDeriveKey', () => {
      const bufKey = randomBytes(32);
      const derived = service.validateAndDeriveKey(bufKey);
      expect(derived).toEqual(bufKey);
    });

    it('should fail fast on missing / undefined key', () => {
      expect(() => service.validateAndDeriveKey(undefined)).toThrow(
        InvalidEncryptionKeyError,
      );
      expect(() => service.validateAndDeriveKey('')).toThrow(
        InvalidEncryptionKeyError,
      );
    });

    it('should fail fast on keys with invalid length (not 32 bytes / 256 bits)', () => {
      expect(() => service.validateAndDeriveKey('too-short-key')).toThrow(
        InvalidEncryptionKeyError,
      );
      expect(() => service.validateAndDeriveKey(randomBytes(16))).toThrow(
        InvalidEncryptionKeyError,
      );
      expect(() => service.validateAndDeriveKey(randomBytes(64))).toThrow(
        InvalidEncryptionKeyError,
      );
      // 63 hex chars (missing 1 char)
      expect(() =>
        service.validateAndDeriveKey(
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde',
        ),
      ).toThrow(InvalidEncryptionKeyError);
    });

    it('should not leak the plaintext key in error messages', () => {
      const secretAttempt = 'my_super_secret_password_that_is_short';
      try {
        service.validateAndDeriveKey(secretAttempt);
        expect.unreachable('Should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(InvalidEncryptionKeyError);
        expect((err as Error).message).not.toContain(secretAttempt);
      }
    });
  });

  describe('AES-256-GCM Encryption & Decryption Correctness', () => {
    it('should encrypt and decrypt plaintext strings accurately', () => {
      const secret = 'agent_stellar_priv_key_SD6W...999';
      const encrypted = service.encrypt(secret);

      expect(typeof encrypted).toBe('string');
      expect(encrypted).toMatch(/^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i);

      const decrypted = service.decrypt(encrypted);
      expect(decrypted).toBe(secret);
    });

    it('should encrypt and decrypt UTF-8 multi-byte strings and emojis', () => {
      const unicodeSecret = '🔒 Sensitive Agent Key 🔑 with utf-8 🌟 and newline \n \t';
      const encrypted = service.encrypt(unicodeSecret);
      const decrypted = service.decrypt(encrypted);
      expect(decrypted).toBe(unicodeSecret);
    });

    it('should encrypt and decrypt empty string', () => {
      const encrypted = service.encrypt('');
      const decrypted = service.decrypt(encrypted);
      expect(decrypted).toBe('');
    });

    it('should encrypt and decrypt raw buffers via encryptBuffer & decryptBuffer', () => {
      const rawData = randomBytes(256);
      const encrypted = service.encryptBuffer(rawData);

      expect(encrypted.iv.length).toBe(12);
      expect(encrypted.authTag.length).toBe(16);
      expect(encrypted.ciphertext.length).toBe(256);

      const decrypted = service.decryptBuffer(encrypted);
      expect(decrypted.equals(rawData)).toBe(true);
    });

    it('should encrypt and decrypt JSON objects via encryptObject & decryptObject', () => {
      const secretPayload = {
        apiKey: 'ak_live_xyz987654321',
        privateKey: 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        subAccount: {
          seed: 'secret-seed-value',
        },
        roles: ['finance', 'executor'],
      };

      const encrypted = service.encryptObject(secretPayload);
      expect(service.isEncrypted(encrypted)).toBe(true);

      const decrypted = service.decryptObject<typeof secretPayload>(encrypted);
      expect(decrypted).toEqual(secretPayload);
    });
  });

  describe('IV Uniqueness & Non-Determinism (Semantic Security)', () => {
    it('should produce unique IVs and distinct ciphertexts for repeated encryptions of identical plaintext', () => {
      const plaintext = 'identical_agent_private_key_content';
      const count = 50;
      const ciphertexts = new Set<string>();
      const ivs = new Set<string>();

      for (let i = 0; i < count; i++) {
        const encrypted = service.encrypt(plaintext);
        const parsed = service.deserialize(encrypted);

        ciphertexts.add(encrypted);
        ivs.add(parsed.iv);

        // Every single ciphertext must decrypt back to the identical plaintext
        expect(service.decrypt(encrypted)).toBe(plaintext);
      }

      expect(ciphertexts.size).toBe(count);
      expect(ivs.size).toBe(count);
    });
  });

  describe('Decryption Failure Handling & Tamper Resistance', () => {
    it('should throw DecryptionException if ciphertext is modified/tampered', () => {
      const plaintext = 'stellar_agent_secret';
      const encrypted = service.encrypt(plaintext);
      const parsed = service.deserialize(encrypted);

      // Flip the last byte of the ciphertext hex
      const tamperedCiphertext =
        parsed.ciphertext.slice(0, -1) + (parsed.ciphertext.endsWith('a') ? 'b' : 'a');

      const tamperedPayload = service.serialize({
        ...parsed,
        ciphertext: tamperedCiphertext,
      });

      expect(() => service.decrypt(tamperedPayload)).toThrow(DecryptionException);
    });

    it('should throw DecryptionException if auth tag is tampered', () => {
      const plaintext = 'stellar_agent_secret';
      const encrypted = service.encrypt(plaintext);
      const parsed = service.deserialize(encrypted);

      const tamperedTag =
        (parsed.authTag.startsWith('0') ? '1' : '0') + parsed.authTag.slice(1);

      const tamperedPayload = service.serialize({
        ...parsed,
        authTag: tamperedTag,
      });

      expect(() => service.decrypt(tamperedPayload)).toThrow(DecryptionException);
    });

    it('should throw DecryptionException if IV is altered', () => {
      const plaintext = 'stellar_agent_secret';
      const encrypted = service.encrypt(plaintext);
      const parsed = service.deserialize(encrypted);

      const tamperedIv =
        (parsed.iv.startsWith('0') ? '1' : '0') + parsed.iv.slice(1);

      const tamperedPayload = service.serialize({
        ...parsed,
        iv: tamperedIv,
      });

      expect(() => service.decrypt(tamperedPayload)).toThrow(DecryptionException);
    });

    it('should throw DecryptionException when decrypted with a different key', () => {
      const differentKey = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
      const encrypted = service.encrypt('sensitive data');

      expect(() =>
        service.decrypt(encrypted, { key: differentKey }),
      ).toThrow(DecryptionException);
    });

    it('should throw DecryptionException on malformed serialized payload strings', () => {
      expect(() => service.decrypt('not-an-encrypted-payload')).toThrow(
        DecryptionException,
      );
      expect(() => service.decrypt('')).toThrow(DecryptionException);
      expect(() => service.decrypt('enc:v1:short')).toThrow(DecryptionException);
    });

    it('should throw DecryptionException when decryptObject fails to parse JSON', () => {
      // Encrypt non-JSON text then try decryptObject
      const encrypted = service.encrypt('just plain text not json');
      expect(() => service.decryptObject(encrypted)).toThrow(DecryptionException);
    });
  });

  describe('Additional Authenticated Data (AAD)', () => {
    it('should successfully decrypt when matching AAD is provided', () => {
      const plaintext = 'agent_transfer_authorization';
      const aad = 'org_018f_agent_42';

      const encrypted = service.encrypt(plaintext, { aad });
      const decrypted = service.decrypt(encrypted, { aad });

      expect(decrypted).toBe(plaintext);
    });

    it('should throw DecryptionException if AAD is mismatched or omitted on decryption', () => {
      const plaintext = 'agent_transfer_authorization';
      const aad = 'org_018f_agent_42';

      const encrypted = service.encrypt(plaintext, { aad });

      // Decrypt without AAD
      expect(() => service.decrypt(encrypted)).toThrow(DecryptionException);

      // Decrypt with wrong AAD
      expect(() =>
        service.decrypt(encrypted, { aad: 'wrong_aad_tenant' }),
      ).toThrow(DecryptionException);
    });
  });

  describe('Encrypted Payload Formats and Detection', () => {
    it('should detect encrypted strings and objects with isEncrypted', () => {
      const encrypted = service.encrypt('test');
      expect(service.isEncrypted(encrypted)).toBe(true);
      expect(service.isEncrypted('plain text')).toBe(false);
      expect(service.isEncrypted(12345)).toBe(false);
      expect(service.isEncrypted(null)).toBe(false);

      const parsed = service.deserialize(encrypted);
      expect(service.isEncrypted(parsed)).toBe(true);
    });

    it('should deserialize 3-part, 4-part and 5-part serialized strings', () => {
      const encrypted = service.encrypt('test');
      const parsed = service.deserialize(encrypted);

      // 5-part standard: enc:v1:iv:tag:data
      expect(service.deserialize(encrypted)).toEqual(parsed);

      // 4-part: v1:iv:tag:data
      const fourPart = `v1:${parsed.iv}:${parsed.authTag}:${parsed.ciphertext}`;
      expect(service.deserialize(fourPart).iv).toBe(parsed.iv);

      // 3-part: iv:tag:data
      const threePart = `${parsed.iv}:${parsed.authTag}:${parsed.ciphertext}`;
      expect(service.deserialize(threePart).iv).toBe(parsed.iv);
    });
  });

  describe('transformSensitiveFields', () => {
    it('should encrypt sensitive fields and leave non-sensitive fields in plaintext', () => {
      const input = {
        name: 'Autonomous Treasury Bot',
        model: 'gpt-4o',
        privateKey: 'S_SECRET_PRIVATE_KEY',
        apiKey: 'ak_live_xyz_key',
        settings: {
          maxDailyBudget: 1000,
          webhookSecret: 'whsec_secret_123',
        },
      };

      const encrypted = service.transformSensitiveFields(input, 'encrypt');

      // Non-sensitive fields remain unchanged
      expect(encrypted.name).toBe('Autonomous Treasury Bot');
      expect(encrypted.model).toBe('gpt-4o');
      expect(encrypted.settings.maxDailyBudget).toBe(1000);

      // Sensitive fields must be encrypted
      expect(service.isEncrypted(encrypted.privateKey)).toBe(true);
      expect(service.isEncrypted(encrypted.apiKey)).toBe(true);
      expect(service.isEncrypted(encrypted.settings.webhookSecret)).toBe(true);
      expect(encrypted.privateKey).not.toBe(input.privateKey);

      // Decrypting must restore original values
      const decrypted = service.transformSensitiveFields(encrypted, 'decrypt');
      expect(decrypted).toEqual(input);
    });

    it('should be idempotent and not re-encrypt already encrypted fields', () => {
      const input = {
        privateKey: 'S_SECRET_KEY',
      };

      const once = service.transformSensitiveFields(input, 'encrypt');
      const twice = service.transformSensitiveFields(once, 'encrypt');

      expect(twice.privateKey).toBe(once.privateKey);

      const decrypted = service.transformSensitiveFields(twice, 'decrypt');
      expect(decrypted.privateKey).toBe(input.privateKey);
    });

    it('should handle nested objects and sensitive field lists', () => {
      expect(SENSITIVE_SECRET_FIELDS.has('privatekey')).toBe(true);
      expect(SENSITIVE_SECRET_FIELDS.has('credentials')).toBe(true);
      expect(SENSITIVE_SECRET_FIELDS.has('apikey')).toBe(true);

      const data = {
        credentials: {
          clientSecret: 'secret_12345',
          accessToken: 'tok_abc',
        },
      };

      const enc = service.transformSensitiveFields(data, 'encrypt');
      expect(service.isEncrypted(enc.credentials)).toBe(true);

      const dec = service.transformSensitiveFields(enc, 'decrypt');
      expect(dec.credentials).toEqual(data.credentials);
    });
  });
});
