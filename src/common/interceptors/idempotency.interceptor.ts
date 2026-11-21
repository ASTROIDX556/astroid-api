import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { Request, Response } from 'express';
import { Observable, of, throwError } from 'rxjs';
import { catchError, concatMap, mergeMap } from 'rxjs/operators';

import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_REPLAYED_HEADER } from '../constants/headers';
import { ErrorCode } from '../constants/error-codes';
import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  IDEMPOTENT_KEY,
  IdempotentOptions,
} from '../decorators/idempotent.decorator';
import { DomainException, ConflictException } from '../exceptions/domain.exception';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import {
  IDEMPOTENCY_STORE,
  IdempotencyIdentity,
  IdempotencyRecord,
  IdempotencyStore,
} from './idempotency-store';

/** `Idempotency-Key` grammar: 1-128 URL-safe ASCII characters. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const DEFAULT_WAIT_FOR_COMPLETION_MS = 2_000;
const COMPLETION_POLL_INTERVAL_MS = 50;

interface IdempotentRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Stable JSON serialisation with sorted object keys, so semantically equal
 * payloads (`{ a: 1, b: 2 }` and `{ b: 2, a: 1 }`) fingerprint identically.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 of the stable body representation; raw bodies are never stored. */
export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/**
 * Enforces idempotent request handling for endpoints marked with
 * `@Idempotent()`.
 *
 * - First request: reserves the key, executes the handler and stores the
 *   status code + response body.
 * - Repeat with the same payload: replays the stored status/body and sets the
 *   `Idempotency-Replayed: true` header.
 * - Repeat with a different payload: 409 without executing anything.
 * - Concurrent duplicates: only the caller that wins the store's unique
 *   constraint executes; the others wait briefly and replay (or 409).
 *
 * The `Idempotency-Key` itself is only ever persisted as a SHA-256 hash and is
 * never logged alongside the request body.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(IDEMPOTENCY_STORE)
    private readonly store?: IdempotencyStore,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const options = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(
      IDEMPOTENT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!options) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<IdempotentRequest>();
    const response = http.getResponse<Response>();
    const key = this.parseKey(request.headers[IDEMPOTENCY_KEY_HEADER], options);

    // An unguarded key (required: false) keeps the endpoint's old behaviour.
    if (!key || !this.store) {
      return next.handle();
    }

    const identity: IdempotencyIdentity = {
      principalId: resolvePrincipal(request.user),
      operation: this.resolveOperation(context),
      keyHash: createHash('sha256').update(key).digest('hex'),
    };
    const requestHash = hashRequestBody(request.body);
    const ttlMs = options.ttlMs ?? this.defaultTtlMs();
    const reservation = await this.store.reserve({
      ...identity,
      requestHash,
      expiresAt: new Date(Date.now() + ttlMs),
    });

    if (!reservation.created) {
      return this.replay(reservation.record, identity, requestHash, response, options);
    }

    return next.handle().pipe(
      concatMap(async (body: unknown) => {
        await this.store!.complete(
          reservation.record.id,
          { statusCode: response.statusCode || 201, body: serialisable(body) },
          new Date(Date.now() + ttlMs),
        );
        return body;
      }),
      catchError((error: unknown) =>
        // The handler failed, so the key must not stay reserved: a client
        // retry is allowed to execute (the endpoint's own retry semantics apply).
        fromPromise(this.store!.release(reservation.record.id)).pipe(
          catchError(() => of(undefined)),
          mergeMap(() => throwError(() => error)),
        ),
      ),
    );
  }

  /** Validates the header, answering 400 for missing/malformed guarded keys. */
  private parseKey(rawHeader: string | string[] | undefined, options: IdempotentOptions): string | undefined {
    const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (raw === undefined || raw === '') {
      if (options.required === false) return undefined;
      throw new DomainException(
        ErrorCode.BAD_REQUEST,
        'Idempotency-Key header is required for this endpoint',
      );
    }
    if (typeof raw !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(raw)) {
      throw new DomainException(
        ErrorCode.BAD_REQUEST,
        'Idempotency-Key must contain 1 to 128 ASCII letters, digits, dots, underscores, tildes, or hyphens',
      );
    }
    return raw;
  }

  /** Replays a completed record, or resolves the concurrent-duplicate case. */
  private async replay(
    record: IdempotencyRecord,
    identity: IdempotencyIdentity,
    requestHash: string,
    response: Response,
    options: IdempotentOptions,
  ): Promise<Observable<unknown>> {
    if (record.requestHash !== requestHash) {
      throw new ConflictException(
        'Idempotency-Key was already used with a different request payload',
      );
    }

    const completed = await this.waitForCompletion(record, identity, options);
    if (!completed?.response) {
      throw new ConflictException(
        'A request with this Idempotency-Key is currently being processed; retry shortly',
      );
    }

    response.setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    response.status(completed.response.statusCode);
    return of(completed.response.body);
  }

  /**
   * Two requests with the same key can overlap. The loser waits a bounded time
   * for the winner to store its response, then replays it; if the winner is
   * still running, the duplicate is rejected with 409 rather than enqueuing a
   * second transaction.
   */
  private async waitForCompletion(
    record: IdempotencyRecord,
    identity: IdempotencyIdentity,
    options: IdempotentOptions,
  ): Promise<IdempotencyRecord | null> {
    if (record.status === 'COMPLETED') return record;

    const waitMs = options.waitForCompletionMs ?? DEFAULT_WAIT_FOR_COMPLETION_MS;
    const deadline = Date.now() + waitMs;
    let current: IdempotencyRecord | null = record;
    while (current?.status !== 'COMPLETED' && Date.now() < deadline) {
      await waitForNextPoll(COMPLETION_POLL_INTERVAL_MS);
      current = await this.store!.find(identity);
      if (!current) return null;
    }
    return current;
  }

  private resolveOperation(context: ExecutionContext): string {
    const controller = context.getClass().name;
    const handler = context.getHandler().name;
    return `${controller}.${handler}`;
  }

  private defaultTtlMs(): number {
    const configured = Number(this.config?.get<string | number>('IDEMPOTENCY_TTL_MS'));
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_IDEMPOTENCY_TTL_MS;
  }
}

/**
 * Tenant-scoped actor. API-key requests are scoped by the API key itself so
 * two keys belonging to the same user do not share replay records; JWT
 * requests are scoped by the authenticated user.
 */
function resolvePrincipal(user: AuthenticatedUser | undefined): string {
  const organizationId = user?.organizationId ?? 'anonymous';
  const actorId = user?.isApiKey
    ? user.apiKeyId ?? user.id
    : user?.id ?? user?.sub ?? 'anonymous';
  return `${organizationId}:${actorId}`;
}

/** Round-trips through JSON so Prisma can persist dates/decimals safely. */
function serialisable(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return null;
  }
}

function fromPromise<T>(promise: Promise<T>): Observable<T> {
  return new Observable<T>((subscriber) => {
    promise.then(
      (value) => {
        subscriber.next(value);
        subscriber.complete();
      },
      (error: unknown) => subscriber.error(error),
    );
  });
}

function waitForNextPoll(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
