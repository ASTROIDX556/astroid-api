import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { API_KEY_SCOPE_VALUES } from '../../common/constants/api-key-scopes';

export const createApiKeySchema = z
  .object({
    name: z.string().min(1).max(120),
    // Individual scope strings are validated against the canonical list in the
    // service so an unknown value fails with a 400 that lists the allowed set.
    scopes: z.array(z.string().min(1).max(60)).max(50).default([]),
    permissions: z.array(z.string().max(60)).max(50).default([]),
    allowedIps: z.array(z.string().max(45)).max(50).default([]),
    expiresInDays: z.number().int().positive().max(365).optional(),
  })
  .strict();
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export const updateApiKeySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    scopes: z.array(z.string().min(1).max(60)).max(50).optional(),
    allowedIps: z.array(z.string().max(45)).max(50).optional(),
  })
  .strict();
export type UpdateApiKeyInput = z.infer<typeof updateApiKeySchema>;

// ── Swagger DTOs ──

export class CreateApiKeyDto {
  @ApiProperty({ example: 'CI pipeline' })
  name!: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['transaction:read', 'wallet:read'],
    description: `Scopes granted to the key. Omit to create an unrestricted key. Allowed: ${API_KEY_SCOPE_VALUES.join(', ')}`,
  })
  scopes?: string[];

  @ApiPropertyOptional({ type: [String], example: ['transactions:read', 'wallets:read'] })
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

export class UpdateApiKeyDto {
  @ApiPropertyOptional({ example: 'CI pipeline (read-only)' })
  name?: string;

  @ApiPropertyOptional({
    type: [String],
    description: `Replacement scope set. Allowed: ${API_KEY_SCOPE_VALUES.join(', ')}`,
  })
  scopes?: string[];

  @ApiPropertyOptional({ type: [String] })
  allowedIps?: string[];
}

export class ApiKeyCreatedDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Short identifying prefix, safe to display' })
  prefix!: string;

  @ApiProperty({ type: [String], description: 'Scopes granted to this key' })
  scopes!: string[];

  @ApiProperty({
    description:
      'The full API key. Returned exactly once — it is hashed before storage and can never be retrieved again.',
  })
  key!: string;
}
