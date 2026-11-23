import { UserRole } from '@prisma/client';

/** The authenticated principal attached to each request by the JWT strategy. */
export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  email: string;
  role: UserRole;
  sessionId?: string;
}

/**
 * The principal attached to the request when it is authenticated with an API
 * key. Scope checks read only from this object; the guard never re-parses the
 * presented credential.
 */
export interface AuthenticatedApiKey {
  id: string;
  organizationId: string;
  name: string;
  prefix: string;
  scopes: string[];
  permissions: string[];
  revokedAt?: Date | null;
  expiresAt?: Date | null;
}

/** Shape of the JWT access-token payload. */
export interface JwtAccessPayload {
  sub: string;
  organizationId: string;
  email: string;
  role: UserRole;
  sessionId?: string;
}

/** Shape of the JWT refresh-token payload. */
export interface JwtRefreshPayload {
  sub: string;
  sessionId: string;
}
