import { describe, expect, it } from 'vitest';
import { RequestContext, RequestContextData } from '../common/context/request-context';
import {
  currentJobMetadata,
  NO_REQUEST_CONTEXT,
  readJobMetadata,
  withJobMetadata,
} from './job-correlation';

function context(overrides: Partial<RequestContextData> & { requestId?: string } = {}): RequestContextData {
  const requestId = overrides.requestId ?? 'req-1';
  return {
    identity: {
      requestId,
      correlationId: `corr-of-${requestId}`,
      traceId: `trace-of-${requestId}`,
      method: 'POST',
      path: '/api/v1/transactions',
      url: '/api/v1/transactions',
      ip: null,
      userAgent: null,
      startedAt: Date.now(),
    },
    principal: overrides.principal,
    timings: {},
    data: {},
  };
}

describe('currentJobMetadata', () => {
  it('is empty outside a request, so a scheduler or seed enqueues no metadata', () => {
    expect(currentJobMetadata()).toEqual({});
  });

  it('reads the request id, correlation fields, actor and API key id of the request', () => {
    const metadata = RequestContext.run(
      context({ principal: { userId: 'user-1', apiKeyId: 'key-1', authMethod: 'api-key' } }),
      () => currentJobMetadata(),
    );

    expect(metadata).toEqual({
      requestId: 'req-1',
      correlationId: 'corr-of-req-1',
      traceId: 'trace-of-req-1',
      actorId: 'user-1',
      apiKeyId: 'key-1',
    });
  });

  it('leaves out the fields the request does not have', () => {
    const metadata = RequestContext.run(context(), () => currentJobMetadata());

    expect(metadata).not.toHaveProperty('actorId');
    expect(metadata).not.toHaveProperty('apiKeyId');
    expect(metadata.requestId).toBe('req-1');
  });

  it('uses the agent as the actor when the request has no user', () => {
    const metadata = RequestContext.run(
      context({ principal: { agentId: 'agent-1', authMethod: 'service' } }),
      () => currentJobMetadata(),
    );

    expect(metadata.actorId).toBe('agent-1');
  });

  it('prefers the user over the agent', () => {
    const metadata = RequestContext.run(
      context({ principal: { userId: 'user-1', agentId: 'agent-1' } }),
      () => currentJobMetadata(),
    );

    expect(metadata.actorId).toBe('user-1');
  });

  it('follows nested contexts: the innermost request wins, and the outer one is restored', () => {
    RequestContext.run(context({ requestId: 'outer' }), () => {
      expect(currentJobMetadata().requestId).toBe('outer');

      RequestContext.run(context({ requestId: 'inner' }), () => {
        expect(currentJobMetadata().requestId).toBe('inner');
      });

      expect(currentJobMetadata().requestId).toBe('outer');
    });
    expect(currentJobMetadata()).toEqual({});
  });

  it('survives awaits and timers inside the request', async () => {
    const seen = await RequestContext.run(context(), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return currentJobMetadata().requestId;
    });

    expect(seen).toBe('req-1');
  });

  it('keeps concurrent requests apart', async () => {
    const read = (requestId: string, delayMs: number) =>
      RequestContext.run(context({ requestId }), async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return currentJobMetadata().requestId;
      });

    await expect(Promise.all([read('slow', 20), read('fast', 1)])).resolves.toEqual(['slow', 'fast']);
  });
});

describe('withJobMetadata', () => {
  const payload = { organizationId: 'org-1', transactionId: 'tx-1' };

  it('returns the payload unchanged outside a request', () => {
    expect(withJobMetadata(payload)).toBe(payload);
  });

  it('adds the current request’s fields under `metadata` without touching the rest', () => {
    const job = RequestContext.run(context({ principal: { userId: 'user-1' } }), () =>
      withJobMetadata(payload),
    );

    expect(job).toEqual({
      ...payload,
      metadata: {
        requestId: 'req-1',
        correlationId: 'corr-of-req-1',
        traceId: 'trace-of-req-1',
        actorId: 'user-1',
      },
    });
    expect(payload).not.toHaveProperty('metadata');
  });

  it('keeps fields the producer already set over the ambient request', () => {
    const job = RequestContext.run(context({ requestId: 'ambient' }), () =>
      withJobMetadata({ ...payload, metadata: { requestId: 'from-payload' } }),
    );

    expect(job.metadata).toMatchObject({ requestId: 'from-payload', correlationId: 'corr-of-ambient' });
  });

  it('lets explicit fields (for example from a domain event) win over both', () => {
    const job = RequestContext.run(context({ requestId: 'ambient' }), () =>
      withJobMetadata(
        { ...payload, metadata: { requestId: 'from-payload' } },
        { requestId: 'from-event', actorId: 'event-actor' },
      ),
    );

    expect(job.metadata).toMatchObject({ requestId: 'from-event', actorId: 'event-actor' });
  });

  it('ignores explicit fields that are empty', () => {
    const job = RequestContext.run(context(), () =>
      withJobMetadata(payload, { requestId: undefined, actorId: '' }),
    );

    expect(job.metadata?.requestId).toBe('req-1');
    expect(job.metadata).not.toHaveProperty('actorId');
  });

  it('writes metadata outside a request when the producer supplies some', () => {
    expect(withJobMetadata(payload, { requestId: 'from-event' })).toEqual({
      ...payload,
      metadata: { requestId: 'from-event' },
    });
  });
});

describe('readJobMetadata', () => {
  it('reads nested metadata', () => {
    expect(readJobMetadata({ metadata: { requestId: 'req-1', actorId: 'user-1' } })).toEqual({
      requestId: 'req-1',
      actorId: 'user-1',
    });
  });

  it('falls back to the top level of an older payload', () => {
    expect(readJobMetadata({ requestId: 'req-old', actorId: 'user-old' })).toEqual({
      requestId: 'req-old',
      actorId: 'user-old',
    });
  });

  it('prefers nested metadata over top-level fields', () => {
    expect(readJobMetadata({ requestId: 'top', metadata: { requestId: 'nested' } }).requestId).toBe('nested');
  });

  it.each([null, undefined, 'text', 7, true, [], {}, { metadata: null }, { metadata: 'x' }])(
    'returns an empty result for %j',
    (data) => {
      expect(readJobMetadata(data)).toEqual({});
    },
  );

  it('drops values that are not non-empty strings', () => {
    expect(
      readJobMetadata({ metadata: { requestId: 1, correlationId: '', traceId: null, actorId: {}, apiKeyId: 'key-1' } }),
    ).toEqual({ apiKeyId: 'key-1' });
  });

  it('ignores unrelated fields, including anything secret-looking', () => {
    expect(readJobMetadata({ metadata: { requestId: 'req-1', apiKey: 'ak_live_secret', signedXdr: 'AAAA' } })).toEqual({
      requestId: 'req-1',
    });
  });
});

describe('NO_REQUEST_CONTEXT', () => {
  it('is not shaped like a request id a client could send or search for', () => {
    expect(NO_REQUEST_CONTEXT).toBe('no-request-context');
    expect(NO_REQUEST_CONTEXT).not.toMatch(/^req[-_]/i);
  });
});
