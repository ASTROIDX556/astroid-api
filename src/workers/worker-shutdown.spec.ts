import { describe, it, expect, vi } from 'vitest';
import { WebhookWorker } from '../modules/webhooks/workers/webhook.worker';
import { TransactionWorker } from '../modules/transactions/workers/transaction.worker';

describe('Worker Graceful Shutdown & Lifecycle', () => {
  it('closes webhook worker gracefully on module destroy', async () => {
    const worker = new WebhookWorker();
    const closeMock = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.defineProperty(worker, 'worker', {
      value: { close: closeMock },
      configurable: true,
    });

    await worker.onModuleDestroy();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('closes transaction worker gracefully on module destroy', async () => {
    const worker = new TransactionWorker();
    const closeMock = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.defineProperty(worker, 'worker', {
      value: { close: closeMock },
      configurable: true,
    });

    await worker.onModuleDestroy();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('registers error and event listeners on worker initialization', async () => {
    const worker = new WebhookWorker();
    const onMock = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.defineProperty(worker, 'worker', {
      value: { on: onMock },
      configurable: true,
    });

    await worker.onApplicationBootstrap();
    expect(onMock).toHaveBeenCalledWith('failed', expect.any(Function));
    expect(onMock).toHaveBeenCalledWith('error', expect.any(Function));
    expect(onMock).toHaveBeenCalledWith('stalled', expect.any(Function));
  });
});
