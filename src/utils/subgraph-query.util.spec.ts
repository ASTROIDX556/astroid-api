import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSubgraphQuery } from './subgraph-query.util';
import { TtlCache } from './ttl-cache.util';

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe('executeSubgraphQuery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries transient 5xx failures and eventually succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { data: { healthy: true } }));

    const promise = executeSubgraphQuery({
      url: 'https://subgraph.example/graphql',
      query: '{ health }',
      fetchImpl,
      maxAttempts: 3,
      baseDelayMs: 100,
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ healthy: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries transient network errors and eventually succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: 1 } }));

    const promise = executeSubgraphQuery({
      url: 'https://subgraph.example/graphql',
      query: '{ ok }',
      fetchImpl,
      maxAttempts: 3,
      baseDelayMs: 100,
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting the configured max attempts on persistent failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, {}));

    const promise = executeSubgraphQuery({
      url: 'https://subgraph.example/graphql',
      query: '{ health }',
      fetchImpl,
      maxAttempts: 2,
      baseDelayMs: 10,
    });
    const expectation = expect(promise).rejects.toThrow('Subgraph query failed with status 503');
    await vi.runAllTimersAsync();
    await expectation;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails immediately without retrying on client-side 4xx responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { errors: [{ message: 'Syntax error' }] }));

    await expect(
      executeSubgraphQuery({
        url: 'https://subgraph.example/graphql',
        query: '{ broken }',
        fetchImpl,
        maxAttempts: 3,
        baseDelayMs: 10,
      }),
    ).rejects.toThrow('Subgraph query failed with status 400');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails immediately without retrying on GraphQL execution errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { errors: [{ message: 'Cannot query field' }] }));

    await expect(
      executeSubgraphQuery({
        url: 'https://subgraph.example/graphql',
        query: '{ missing }',
        fetchImpl,
        maxAttempts: 3,
        baseDelayMs: 10,
      }),
    ).rejects.toThrow('Cannot query field');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('waits for the exponential backoff delay before retrying', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { data: { value: 42 } }));

    const promise = executeSubgraphQuery({
      url: 'https://subgraph.example/graphql',
      query: '{ value }',
      fetchImpl,
      maxAttempts: 3,
      baseDelayMs: 100,
    });

    // First attempt fails; the retry is scheduled after the first backoff delay (100ms).
    await vi.advanceTimersByTimeAsync(99);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10);
    await expect(promise).resolves.toEqual({ value: 42 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caps the delay between attempts at maxDelayMs', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { data: { value: 7 } }));

    const promise = executeSubgraphQuery({
      url: 'https://subgraph.example/graphql',
      query: '{ value }',
      fetchImpl,
      maxAttempts: 2,
      baseDelayMs: 10_000,
      maxDelayMs: 250,
    });
    await vi.advanceTimersByTimeAsync(300);
    await expect(promise).resolves.toEqual({ value: 7 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns the subgraph data on the first attempt when the query succeeds', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { account: { id: 'acc1' } } }));

    await expect(
      executeSubgraphQuery({ url: 'https://subgraph.example/graphql', query: '{ account }', fetchImpl }),
    ).resolves.toEqual({ account: { id: 'acc1' } });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('executeSubgraphQuery caching (immutable reads)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves repeated immutable queries from the cache without refetching', async () => {
    const cache = new TtlCache();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { stream: { id: 's1' } } }));
    const options = {
      url: 'https://subgraph.example/graphql',
      query: '{ stream(id: "s1") { id } }',
      fetchImpl,
      cache,
      cacheTtlMs: 60_000,
    };

    await expect(executeSubgraphQuery(options)).resolves.toEqual({ stream: { id: 's1' } });
    await expect(executeSubgraphQuery(options)).resolves.toEqual({ stream: { id: 's1' } });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cache.stats.hits).toBe(1);
  });

  it('does not cache when cacheTtlMs is omitted', async () => {
    const cache = new TtlCache();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { value: 1 } }));
    const options = {
      url: 'https://subgraph.example/graphql',
      query: '{ value }',
      fetchImpl,
      cache,
    };

    await executeSubgraphQuery(options);
    await executeSubgraphQuery(options);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it('bypasses the cache when fresh data is explicitly required', async () => {
    const cache = new TtlCache();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: { revision: 1 } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { revision: 2 } }));
    const base = {
      url: 'https://subgraph.example/graphql',
      query: '{ revision }',
      fetchImpl,
      cache,
      cacheTtlMs: 60_000,
    };

    await expect(executeSubgraphQuery(base)).resolves.toEqual({ revision: 1 });
    await expect(executeSubgraphQuery({ ...base, bypassCache: true })).resolves.toEqual({ revision: 2 });
    // The bypassed fetch refreshed the entry, so the next read is served fresh from cache.
    await expect(executeSubgraphQuery(base)).resolves.toEqual({ revision: 2 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caches by url + query + variables', async () => {
    const cache = new TtlCache();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: { stream: 'a' } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { stream: 'b' } }));
    const base = { url: 'https://subgraph.example/graphql', fetchImpl, cache, cacheTtlMs: 60_000 };

    await expect(
      executeSubgraphQuery({ ...base, query: 'query($id: ID!) { stream(id: $id) }', variables: { id: 'a' } }),
    ).resolves.toEqual({ stream: 'a' });
    await expect(
      executeSubgraphQuery({ ...base, query: 'query($id: ID!) { stream(id: $id) }', variables: { id: 'b' } }),
    ).resolves.toEqual({ stream: 'b' });
    // Same key again — served from cache.
    await expect(
      executeSubgraphQuery({ ...base, query: 'query($id: ID!) { stream(id: $id) }', variables: { id: 'a' } }),
    ).resolves.toEqual({ stream: 'a' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not cache failed queries, so a later call retries the fetch', async () => {
    const cache = new TtlCache();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { errors: [{ message: 'Syntax error' }] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));
    const options = {
      url: 'https://subgraph.example/graphql',
      query: '{ ok }',
      fetchImpl,
      cache,
      cacheTtlMs: 60_000,
      maxAttempts: 2,
      baseDelayMs: 1,
    };

    await expect(executeSubgraphQuery(options)).rejects.toThrow('Subgraph query failed with status 400');
    expect(cache.size).toBe(0);

    await expect(executeSubgraphQuery(options)).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
