import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const createApiKeySchema = z
  .object({
    name: z.string().min(1).max(120),
    permissions: z.array(z.string().max(60)).max(50).default([]),
    allowedIps: z.array(z.string().max(45)).max(50).default([]),
    expiresInDays: z.number().int().positive().max(365).optional(),
  })
  .strict();
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

// ── Swagger DTOs ──

export class CreateApiKeyDto {
  @ApiProperty({ example: 'CI pipeline', description: 'Human-readable name of the key' })
  name!: string;

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

  @ApiPropertyOptional({ description: 'Optional expiry in days (max 365)' })
  expiresInDays?: number;
}

export class ApiKeyCreatedDto {
  @ApiProperty({ description: 'API key id', example: '018f0a1b-4444-4000-8000-000000000000' })
  id!: string;

  @ApiProperty({ description: 'Short identifying prefix, safe to display' })
  prefix!: string;

  @ApiProperty({
    description:
      'The full API key. Returned exactly once — it is hashed before storage and can never be retrieved again.',
  })
  key!: string;
}


/** An API key as returned by the API — the secret itself is never returned. */
export class ApiKeyResponseDto {
  @ApiProperty({ description: 'API key id', format: 'uuid', example: '018f0a1b-4444-4000-8000-000000000000' })
  id!: string;

  @ApiProperty({ description: 'Human-readable name of the key', example: 'CI pipeline' })
  name!: string;

  @ApiProperty({ description: 'Public prefix of the key, used to identify it in logs', example: 'ast_live_ab12' })
  prefix!: string;

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
