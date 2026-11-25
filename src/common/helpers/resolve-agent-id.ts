import { Request } from 'express';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/** Request shape the agent identity can be resolved from. */
export interface AgentIdentityRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Resolves the agent a request declares as its acting agent.
 *
 * The platform carries the acting agent in several places, and they are
 * consulted in order of authority:
 *
 *  1. `params.agentId` — the agent a command addresses (`/agents/:id/...`).
 *  2. `body.agentId` — the agent a transaction is submitted for.
 *  3. `query.agentId` — the agent a filtered request targets.
 *  4. the `x-agent-id` header — the agent an autonomous client declares.
 *
 * The value is used to bucket rate limits. It is therefore only ever an
 * identifier: no credential is stored in Redis, and the raw API key is never
 * used for bucketing (the caller hashes it).
 */
export function resolveRequestAgentId(request: AgentIdentityRequest): string | undefined {
  const fromParams = request.params?.agentId;
  const fromBody = (request.body as Record<string, unknown> | undefined)?.agentId;
  const fromQuery = request.query?.agentId;
  const fromHeader = request.headers?.['x-agent-id'];

  const candidate = [fromParams, fromBody, fromQuery, fromHeader].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );

  return candidate ? candidate.trim() : undefined;
}

/**
 * Resolves the acting agent of a request, falling back to the API-key
 * principal: an API key acts on behalf of a single agent, so the key id
 * identifies the acting agent when the request does not name one.
 */
export function resolveAgentId(request: AgentIdentityRequest): string | undefined {
  const declared = resolveRequestAgentId(request);
  if (declared) {
    return declared;
  }

  if (request.user?.isApiKey && request.user.id) {
    return request.user.id;
  }

  return undefined;
}
