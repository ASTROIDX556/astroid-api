import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitState } from '../../common/circuit-breaker/circuit-breaker';
import { ErrorCode, ERROR_STATUS } from '../../common/constants/error-codes';
import {
  FetchLike,
  SorobanRequestRejectedException,
  SorobanRpcClient,
  SorobanRpcClientOptions,
  SorobanUnavailableException,
} from './soroban.client';

type FetchResponse = Awaited<ReturnType<FetchLike>>;

const ENDPOINT = 'https://rpc.example.test';

function jsonResponse(status: number, body: unknown): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

const ok = (result: unknown): FetchResponse => jsonResponse(200, { jsonrpc: '2.0', id: 1, result });
const httpStatus = (status: number): FetchResponse => jsonResponse(status, {});

/** A fetch that never settles on its own and rejects when its signal aborts. */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

function buildClient(
  fetchImpl: FetchLike,
  overrides: Partial<SorobanRpcClientOptions> = {},
): { client: SorobanRpcClient; logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } } {
  const logger = { log: vi.fn(), warn: vi.fn() };
  const client = new SorobanRpcClient({
    endpoint: ENDPOINT,
    timeoutMs: 1_000,
    maxAttempts: 3,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 500,
    failureThreshold: 5,
    cooldownMs: 10_000,
    fetch: fetchImpl,
    logger,
    ...overrides,
  });
  return { client, logger };
}

/** Runs a call to completion under fake timers and returns its settled outcome. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return outcome;
}

describe('SorobanRpcClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the typed JSON-RPC result and sends a JSON-RPC 2.0 request', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(ok({ latestLedger: 42 }));
    const { client } = buildClient(fetchImpl);

    const { value } = await settle(client.call<{ latestLedger: number }>('getLatestLedger'));

    expect(value).toEqual({ latestLedger: 42 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ jsonrpc: '2.0', method: 'getLatestLedger' });
  });

  it('aborts an attempt after the timeout and reports a timeout once retries are exhausted', async () => {
    const fetchImpl = vi.fn<FetchLike>(hangingFetch);
    const { client } = buildClient(fetchImpl);

    const { error } = await settle(client.call('getHealth'));

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);
    expect(error).toBeInstanceOf(SorobanUnavailableException);
    expect((error as SorobanUnavailableException).details).toMatchObject({
      reason: 'timeout',
      attempts: 3,
      endpoint: ENDPOINT,
      method: 'getHealth',
    });
  });

  it('retries a transient failure and then succeeds', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(httpStatus(503))
      .mockResolvedValueOnce(ok('healthy'));
    const { client, logger } = buildClient(fetchImpl);

    const { value, error } = await settle(client.call<string>('getHealth'));

    expect(error).toBeUndefined();
    expect(value).toBe('healthy');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('(network); retrying'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('(server_error); retrying'));
  });

  it('retries HTTP 429', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValueOnce(httpStatus(429)).mockResolvedValueOnce(ok(1));
    const { client } = buildClient(fetchImpl);

    const { value } = await settle(client.call<number>('getHealth'));

    expect(value).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('waits a jittered backoff between attempts', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValueOnce(httpStatus(500)).mockResolvedValueOnce(ok(1));
    const { client } = buildClient(fetchImpl, { retryBaseDelayMs: 100 });

    const pending = client.call('getHealth');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Base 100ms; jitter adds at most 20% of base on the first retry.
    await vi.advanceTimersByTimeAsync(99);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(21);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toBe(1);
  });

  it('surfaces retry exhaustion as SOROBAN_UNAVAILABLE (503) with the last status', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(httpStatus(502));
    const { client } = buildClient(fetchImpl);

    const { error } = await settle(client.call('simulateTransaction'));

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(SorobanUnavailableException);
    const typed = error as SorobanUnavailableException;
    expect(typed.code).toBe(ErrorCode.SOROBAN_UNAVAILABLE);
    expect(ERROR_STATUS[typed.code]).toBe(503);
    expect(typed.details).toMatchObject({ reason: 'server_error', attempts: 3, status: 502 });
  });

  it.each([400, 401, 404, 413])('fails a non-retryable HTTP %i after a single attempt', async (status) => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(httpStatus(status));
    const { client } = buildClient(fetchImpl);

    const { error } = await settle(client.call('simulateTransaction'));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(SorobanRequestRejectedException);
    const typed = error as SorobanRequestRejectedException;
    expect(typed.code).toBe(ErrorCode.SOROBAN_REQUEST_REJECTED);
    expect(typed.details).toMatchObject({ status, method: 'simulateTransaction' });
  });

  it('fails a JSON-RPC error object after a single attempt', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse(200, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params' } }));
    const { client } = buildClient(fetchImpl);

    const { error } = await settle(client.call('simulateTransaction'));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(SorobanRequestRejectedException);
    expect((error as SorobanRequestRejectedException).details).toMatchObject({ rpcCode: -32602 });
  });

  it('does not count rejected requests against the circuit breaker', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(httpStatus(400));
    const { client } = buildClient(fetchImpl, { failureThreshold: 2 });

    for (let i = 0; i < 5; i++) await settle(client.call('simulateTransaction'));

    expect(client.getCircuitState()).toBe(CircuitState.CLOSED);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  describe('circuit breaker', () => {
    it('opens after the failure threshold and then fails fast without calling the endpoint', async () => {
      const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(httpStatus(503));
      const { client, logger } = buildClient(fetchImpl, { maxAttempts: 1, failureThreshold: 3 });

      for (let i = 0; i < 2; i++) await settle(client.call('getHealth'));
      expect(client.getCircuitState()).toBe(CircuitState.CLOSED);

      await settle(client.call('getHealth'));
      expect(client.getCircuitState()).toBe(CircuitState.OPEN);
      expect(logger.warn).toHaveBeenCalledWith(
        `Soroban RPC circuit OPEN for ${ENDPOINT} (consecutive failures: 3)`,
      );

      const { error } = await settle(client.call('getHealth'));
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(error).toBeInstanceOf(SorobanUnavailableException);
      expect((error as SorobanUnavailableException).details).toMatchObject({
        reason: 'circuit_open',
        attempts: 0,
      });
      expect((error as SorobanUnavailableException).details.retryAfterMs).toBeGreaterThan(0);
    });

    it('stops retrying mid-call once the breaker opens', async () => {
      const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(httpStatus(503));
      const { client } = buildClient(fetchImpl, { maxAttempts: 3, failureThreshold: 2 });

      const { error } = await settle(client.call('getHealth'));

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect((error as SorobanUnavailableException).details).toMatchObject({
        reason: 'circuit_open',
        attempts: 2,
        status: 503,
      });
    });

    it('lets one half-open probe through after the cooldown and closes on success', async () => {
      const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(httpStatus(503));
      const { client, logger } = buildClient(fetchImpl, {
        maxAttempts: 1,
        failureThreshold: 1,
        cooldownMs: 10_000,
      });

      await settle(client.call('getHealth'));
      expect(client.getCircuitState()).toBe(CircuitState.OPEN);

      // Still inside the cooldown: fail fast.
      await vi.advanceTimersByTimeAsync(9_999);
      await settle(client.call('getHealth'));
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      fetchImpl.mockResolvedValueOnce(ok('healthy'));
      const { value } = await settle(client.call<string>('getHealth'));

      expect(value).toBe('healthy');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(client.getCircuitState()).toBe(CircuitState.CLOSED);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('circuit HALF_OPEN'));
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('circuit CLOSED'));
    });

    it('allows exactly one concurrent probe while half-open', async () => {
      const fetchImpl = vi.fn<FetchLike>().mockResolvedValueOnce(httpStatus(503));
      const { client } = buildClient(fetchImpl, { maxAttempts: 1, failureThreshold: 1, cooldownMs: 1_000 });

      await settle(client.call('getHealth'));
      await vi.advanceTimersByTimeAsync(1_000);

      fetchImpl.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(ok('probe')), 50)),
      );
      const probe = client.call<string>('getHealth');
      const concurrent = client.call<string>('getHealth');
      const [probeOutcome, concurrentOutcome] = await Promise.all([settle(probe), settle(concurrent)]);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(probeOutcome.value).toBe('probe');
      expect((concurrentOutcome.error as SorobanUnavailableException).details.reason).toBe('circuit_open');
    });

    it('reopens for another cooldown when the half-open probe fails', async () => {
      const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(httpStatus(503));
      const { client } = buildClient(fetchImpl, { maxAttempts: 1, failureThreshold: 1, cooldownMs: 1_000 });

      await settle(client.call('getHealth'));
      await vi.advanceTimersByTimeAsync(1_000);

      await settle(client.call('getHealth'));
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(client.getCircuitState()).toBe(CircuitState.OPEN);

      await settle(client.call('getHealth'));
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });
});
