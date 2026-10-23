import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const registerSchema = z.object({
  organizationName: z.string().min(2).max(120),
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

// ── Swagger DTOs (documentation only; validation is done by Zod pipes) ──

export class RegisterDto {
  @ApiProperty({ example: 'Acme Robotics', description: 'Name of the organization to create' })
  organizationName!: string;

  @ApiProperty({ example: 'Ada Lovelace', description: 'Name of the organization owner' })
  name!: string;

  @ApiProperty({ example: 'ada@acme.com', description: 'Email address of the organization owner' })
  email!: string;

  @ApiProperty({ example: 'a-strong-passphrase', description: 'Password of the organization owner', minLength: 8 })
  password!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'ada@acme.com', description: 'Registered email address' })
  email!: string;

  @ApiProperty({ example: 'a-strong-passphrase', description: 'Account password' })
  password!: string;
}

export class RefreshDto {
  @ApiProperty({ example: 'rt_018f...', description: 'Refresh token returned by the login or register call' })
  refreshToken!: string;
}

export class TokenPairDto {
  @ApiProperty({ example: 'eyJhbGciOi...', description: 'Short-lived JWT access token' })
  accessToken!: string;

  @ApiProperty({ example: 'rt_018f...', description: 'Opaque refresh token — send it to POST /auth/refresh' })
  refreshToken!: string;

  @ApiProperty({ example: 900, description: 'Access-token lifetime in seconds' })
  expiresIn!: number;

  @ApiPropertyOptional({ example: 'Bearer', description: 'Type of the access token' })
  tokenType?: string;
}

/** The authenticated user as returned by the API. */
export class CurrentUserDto {
  @ApiProperty({ description: 'User id', format: 'uuid', example: '018f0a1b-1111-4000-8000-000000000000' })
  id!: string;

  @ApiProperty({ description: 'Organization the user belongs to', format: 'uuid' })
  organizationId!: string;

  @ApiProperty({ description: 'Display name', example: 'Ada Lovelace' })
  name!: string;

  @ApiProperty({ description: 'Email address', example: 'ada@acme.com' })
  email!: string;

  @ApiProperty({ description: 'Role inside the organization', enum: ['OWNER', 'ADMIN', 'FINANCE', 'DEVELOPER', 'AUDITOR', 'VIEWER'], example: 'OWNER' })
  role!: string;
}

/** The tokens returned by a successful registration or login. */
export class AuthResultDto {
  @ApiProperty({ type: CurrentUserDto, description: 'The authenticated user' })
  user!: CurrentUserDto;

  @ApiProperty({ type: TokenPairDto, description: 'The issued token pair' })
  tokens!: TokenPairDto;
}

/** The acknowledgement returned when a session was revoked. */
export class LogoutResultDto {
  @ApiProperty({ description: 'Whether the session was revoked', example: true })
  success!: boolean;
}
