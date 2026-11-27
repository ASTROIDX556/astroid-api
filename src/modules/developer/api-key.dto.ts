import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  API_KEY_SCOPES,
  ApiKeyScope,
  DEFAULT_API_KEY_SCOPES,
} from '../../common/constants/scopes';

export const createApiKeySchema = z
  .object({
    name: z.string().min(1).max(120),
    scopes: z
      .array(z.enum(API_KEY_SCOPES))
      .min(1)
      .max(API_KEY_SCOPES.length)
      .default([...DEFAULT_API_KEY_SCOPES]),
    permissions: z.array(z.string().max(60)).max(50).default([]),
    allowedIps: z.array(z.string().max(45)).max(50).default([]),
    rateLimitPerMinute: z.number().int().positive().max(100000).optional(),
    rateLimitPerDay: z.number().int().positive().max(10000000).optional(),
    expiresInDays: z.number().int().positive().max(365).optional(),
  })
  .strict();
export type CreateApiKeyInput = z.input<typeof createApiKeySchema>;

export const rotateApiKeySchema = z
  .object({
    gracePeriodSeconds: z.number().int().positive().max(2592000).optional(),
    expiresInDays: z.number().int().positive().max(365).optional(),
  })
  .strict()
  .default({});
export type RotateApiKeyInput = z.input<typeof rotateApiKeySchema>;

// ── Swagger DTOs ──

export class CreateApiKeyDto {
  @ApiProperty({ example: 'CI pipeline', description: 'Human-readable name of the key' })
  name!: string;

  @ApiPropertyOptional({
    type: [String],
    enum: API_KEY_SCOPES,
    example: ['read', 'transactions:execute'],
    description: 'Permission scopes the key grants (default: ["read"])',
  })
  scopes?: ApiKeyScope[];

  @ApiPropertyOptional({
    type: [String],
    example: ['transactions:read', 'wallets:read'],
    description: 'Permissions the key grants',
  })
  permissions?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Optional list of allowed IP addresses or CIDR ranges',
    example: ['192.168.1.50', '10.0.0.0/24'],
  })
  allowedIps?: string[];

  @ApiPropertyOptional({
    description:
      'Optional requests-per-minute override for this key. Omit to keep the configured tier limit.',
    example: 600,
  })
  rateLimitPerMinute?: number;

  @ApiPropertyOptional({
    description:
      'Optional requests-per-day override for this key. Omit to keep the configured default quota.',
    example: 100000,
  })
  rateLimitPerDay?: number;

  @ApiPropertyOptional({ description: 'Optional expiry in days (max 365)' })
  expiresInDays?: number;
}

export class RotateApiKeyDto {
  @ApiPropertyOptional({
    description: 'Grace period in seconds for the existing key to remain valid (default: 86400 = 24h)',
    example: 86400,
  })
  gracePeriodSeconds?: number;

  @ApiPropertyOptional({
    description: 'Optional expiry in days for the newly issued key (max 365)',
    example: 90,
  })
  expiresInDays?: number;
}

export class ApiKeyCreatedDto {
  @ApiProperty({ description: 'API key id', example: '018f0a1b-4444-4000-8000-000000000000' })
  id!: string;

  @ApiProperty({ description: 'Short identifying prefix, safe to display' })
  prefix!: string;

  @ApiPropertyOptional({ description: 'Last four characters of the key, safe to display', example: '1a2b' })
  lastFour?: string;

  @ApiProperty({
    type: [String],
    example: ['read'],
    description: 'Permission scopes granted to the key',
  })
  scopes!: ApiKeyScope[];

  @ApiProperty({
    description:
      'The full API key. Returned exactly once — it is hashed before storage and can never be retrieved again.',
  })
  key!: string;
}

export class ApiKeyRotatedDto {
  @ApiProperty({ description: 'API key id of the newly issued key', example: '018f0a1b-4444-4000-8000-000000000000' })
  id!: string;

  @ApiProperty({ description: 'Short identifying prefix of the new key', example: 'ak_live_ab12' })
  prefix!: string;

  @ApiPropertyOptional({ description: 'Last four characters of the new key', example: '1a2b' })
  lastFour?: string;

  @ApiProperty({
    type: [String],
    example: ['read'],
    description: 'Permission scopes granted to the key',
  })
  scopes!: string[];

  @ApiProperty({
    description:
      'The full new API key. Returned exactly once — it is hashed before storage and can never be retrieved again.',
  })
  key!: string;

  @ApiProperty({ description: 'ID of the rotating previous key', example: '018f0a1b-3333-4000-8000-000000000000' })
  previousKeyId!: string;

  @ApiProperty({ description: 'Moment the previous key expires', example: '2026-04-15T10:30:00.000Z' })
  previousKeyExpiresAt!: Date;
}


/** An API key as returned by the API — the secret itself is never returned. */
export class ApiKeyResponseDto {
  @ApiProperty({ description: 'API key id', format: 'uuid', example: '018f0a1b-4444-4000-8000-000000000000' })
  id!: string;

  @ApiProperty({ description: 'Human-readable name of the key', example: 'CI pipeline' })
  name!: string;

  @ApiProperty({ description: 'Public prefix of the key, used to identify it in logs', example: 'ast_live_ab12' })
  prefix!: string;

  @ApiPropertyOptional({ description: 'Last four characters of the key', example: '1a2b' })
  lastFour?: string;

  @ApiPropertyOptional({ description: 'Lifecycle status of the key', example: 'active' })
  status?: string;

  @ApiProperty({
    type: [String],
    description: 'Permission scopes granted to the key',
    example: ['read', 'transactions:execute'],
  })
  scopes!: ApiKeyScope[];

  @ApiProperty({
    type: [String],
    description: 'Permissions granted to the key',
    example: ['transactions:read', 'transactions:write'],
  })
  permissions!: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Client addresses the key may be used from',
    example: ['203.0.113.7'],
  })
  allowedIps?: string[];

  @ApiPropertyOptional({ description: 'Requests-per-minute override for this key', example: 600 })
  rateLimitPerMinute?: number | null;

  @ApiPropertyOptional({ description: 'Requests-per-day override for this key', example: 100000 })
  rateLimitPerDay?: number | null;

  @ApiPropertyOptional({ description: 'Moment the key was last used', example: '2026-01-15T10:30:00.000Z' })
  lastUsedAt?: string;

  @ApiPropertyOptional({ description: 'Moment the key expires', example: '2026-04-15T10:30:00.000Z' })
  expiresAt?: string;

  @ApiProperty({ description: 'Creation timestamp', example: '2026-01-15T10:30:00.000Z' })
  createdAt!: string;
}

/** The acknowledgement returned when an API key was revoked. */
export class ApiKeyRevokedDto {
  @ApiProperty({ description: 'Id of the revoked key', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Whether the key was revoked', example: true })
  revoked!: boolean;
}
