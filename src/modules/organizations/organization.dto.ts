import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrganizationPlan, UserRole, UserStatus } from '@prisma/client';

export const updateOrganizationSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).optional(),
  logo: z.string().url().optional(),
  plan: z.nativeEnum(OrganizationPlan).optional(),
});

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const inviteMemberSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.nativeEnum(UserRole),
});

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberSchema = z.object({
  role: z.nativeEnum(UserRole).optional(),
  status: z.nativeEnum(UserStatus).optional(),
});

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

/**
 * Request body for admin key rotation. Both fields are optional — the rotation
 * itself is the action — but unknown keys are rejected (strict) so clients get
 * a deterministic validation envelope instead of silently ignored typos.
 */
export const rotateKeysSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

export type RotateKeysInput = z.infer<typeof rotateKeysSchema>;

// ── Swagger DTOs (documentation only; validation is done by Zod pipes) ──

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ example: 'Acme Corp' })
  name?: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional({ example: 'https://example.com/logo.png' })
  logo?: string;

  @ApiPropertyOptional({ enum: OrganizationPlan })
  plan?: OrganizationPlan;
}

export class InviteMemberDto {
  @ApiProperty({ example: 'John Doe' })
  name!: string;

  @ApiProperty({ example: 'john@example.com' })
  email!: string;

  @ApiProperty({ enum: UserRole, example: UserRole.DEVELOPER })
  role!: UserRole;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ enum: UserRole })
  role?: UserRole;

  @ApiPropertyOptional({ enum: UserStatus })
  status?: UserStatus;
}

export class RotateKeysDto {
  @ApiPropertyOptional({ example: 'CI admin key', description: 'Label for the new admin key' })
  name?: string;

  @ApiPropertyOptional({ example: 'Key may have leaked', description: 'Optional reason for the rotation' })
  reason?: string;
}
