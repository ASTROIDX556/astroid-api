import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { ErrorCode } from '../constants/error-codes';

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
};

function buildHost(request: Record<string, unknown> = {}) {
  const response: MockResponse = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const req = {
    method: 'POST',
    url: '/api/v1/transactions',
    headers: {},
    ...request,
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => req }),
  } as unknown as ArgumentsHost;

  return { host, response };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  describe('rate limiting (429)', () => {
    it('renders a ThrottlerException with the uniform error envelope', () => {
      const { host, response } = buildHost();

      filter.catch(new ThrottlerException('Rate limit exceeded'), host);

      expect(response.status).toHaveBeenCalledWith(429);
      expect(response.json).toHaveBeenCalledWith({
        success: false,
        error: { code: ErrorCode.RATE_LIMITED, message: 'Rate limit exceeded' },
        requestId: 'unknown',
      });
    });

    it('propagates the inbound request id so clients can correlate the rejection', () => {
      const { host, response } = buildHost({ headers: { 'x-request-id': 'req-42' } });

      filter.catch(new ThrottlerException(), host);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: ErrorCode.RATE_LIMITED }),
          requestId: 'req-42',
        }),
      );
    });

    it('uses the default throttler message when none is supplied', () => {
      const { host, response } = buildHost();

      filter.catch(new ThrottlerException(), host);

      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'ThrottlerException: Too Many Requests' }),
        }),
      );
    });
  });

  describe('other statuses', () => {
    it('maps a 404 HttpException onto NOT_FOUND', () => {
      const { host, response } = buildHost();

      filter.catch(new HttpException('Resource not found', 404), host);

      expect(response.status).toHaveBeenCalledWith(404);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ code: ErrorCode.NOT_FOUND }) }),
      );
    });

    it('falls back to INTERNAL_ERROR for unknown throwables', () => {
      const { host, response } = buildHost();

      filter.catch(new Error('boom'), host);

      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: ErrorCode.INTERNAL_ERROR }),
        }),
      );
    });
  });
});
