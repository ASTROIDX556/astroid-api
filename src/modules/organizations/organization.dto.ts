import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrganizationPlan, UserRole, UserStatus } from '@prisma/client';
import { sanitizeTextField } from '../../common/validators/text-field.sanitizer';

export const updateOrganizationSchema = z
  .object({
    name: z.string().min(2).max(120).transform(sanitizeTextField).optional(),
    description: z.string().max(500).transform(sanitizeTextField).optional(),
    logo: z.string().url().optional(),
    plan: z.nativeEnum(OrganizationPlan).optional(),
  })
  .strict();

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const inviteMemberSchema = z
  .object({
    name: z.string().min(1).transform(sanitizeTextField),
    email: z.string().email(),
    role: z.nativeEnum(UserRole),
  })
  .strict();

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberSchema = z
  .object({
    role: z.nativeEnum(UserRole).optional(),
    status: z.nativeEnum(UserStatus).optional(),
  })
  .strict();

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

// ── Swagger DTOs (documentation only; validation is done by Zod pipes) ──

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ example: 'Acme Corp', description: 'New name of the organization' })
  name?: string;

  @ApiPropertyOptional({ example: 'Industrial automation', description: 'What the organization does' })
  description?: string;

  @ApiPropertyOptional({ example: 'https://example.com/logo.png', description: 'Logo URL of the organization' })
  logo?: string;

  @ApiPropertyOptional({ enum: OrganizationPlan, description: 'Subscription plan of the organization' })
  plan?: OrganizationPlan;
}

export class InviteMemberDto {
  @ApiProperty({ example: 'John Doe', description: 'Display name of the invited member' })
  name!: string;

  @ApiProperty({ example: 'john@example.com', description: 'Email address the invitation is sent to' })
  email!: string;

  @ApiProperty({
    enum: UserRole,
    enumName: 'UserRole',
    description: 'Role the member gets inside the organization',
    example: 'DEVELOPER',
  })
  role!: UserRole;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ enum: UserRole, description: 'New role of the member' })
  role?: UserRole;

  @ApiPropertyOptional({ enum: UserStatus, description: 'New membership status of the member' })
  status?: UserStatus;
}

/** The organization the caller belongs to. */
export class OrganizationResponseDto {
  @ApiProperty({ description: 'Organization id', format: 'uuid', example: '018f0a1b-0000-4000-8000-000000000000' })
  id!: string;

  @ApiProperty({ description: 'Organization name', example: 'Acme Robotics' })
  name!: string;

  @ApiProperty({ description: 'URL-safe identifier of the organization', example: 'acme-robotics' })
  slug!: string;

  @ApiPropertyOptional({ description: 'Logo URL', example: 'https://cdn.astroid.dev/acme.png' })
  logo?: string;

  @ApiPropertyOptional({ description: 'What the organization does', example: 'Industrial automation' })
  description?: string;

  @ApiProperty({ description: 'Subscription plan', enum: ['FREE', 'STARTER', 'GROWTH', 'ENTERPRISE'], example: 'GROWTH' })
  plan!: string;

  @ApiProperty({ description: 'Subscription status', enum: ['ACTIVE', 'SUSPENDED', 'ARCHIVED'], example: 'ACTIVE' })
  status!: string;

  @ApiProperty({ description: 'Creation timestamp', example: '2026-01-15T10:30:00.000Z' })
  createdAt!: string;
}

/** A member of an organization. */
export class OrganizationMemberDto {
  @ApiProperty({ description: 'User id', format: 'uuid', example: '018f0a1b-1111-4000-8000-000000000000' })
  id!: string;

  @ApiProperty({ description: 'Display name', example: 'Ada Lovelace' })
  name!: string;

  @ApiProperty({ description: 'Email address', example: 'ada@acme.com' })
  email!: string;

  @ApiProperty({ description: 'Role inside the organization', enum: ['OWNER', 'ADMIN', 'FINANCE', 'DEVELOPER', 'AUDITOR', 'VIEWER'], example: 'FINANCE' })
  role!: string;

  @ApiProperty({ description: 'Membership status', enum: ['ACTIVE', 'INVITED', 'SUSPENDED', 'ARCHIVED'], example: 'ACTIVE' })
  status!: string;

  @ApiPropertyOptional({ description: 'Avatar URL' })
  avatar?: string;

  @ApiProperty({ description: 'Creation timestamp', example: '2026-01-15T10:30:00.000Z' })
  createdAt!: string;
}

/** The acknowledgement returned when a member was removed. */
export class MemberRemovedDto {
  @ApiProperty({ description: 'Id of the removed member', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Whether the member was removed', example: true })
  removed!: boolean;
}
