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
  @ApiProperty({ example: 'CI pipeline' })
  name!: string;

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

export class ApiKeyCreatedDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Short identifying prefix, safe to display' })
  prefix!: string;

  @ApiProperty({
    description:
      'The full API key. Returned exactly once — it is hashed before storage and can never be retrieved again.',
  })
  key!: string;
}
