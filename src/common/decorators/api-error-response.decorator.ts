import { ApiErrorResponses as ApiStandardErrorResponses, ApiErrorResponsesOptions } from './api-error-responses.decorator';

const STATUS_OPTIONS: Record<number, keyof ApiErrorResponsesOptions> = {
  400: 'validation',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'notFound',
  409: 'conflict',
  422: 'unprocessable',
  429: 'tooManyRequests',
  500: 'serverError',
  503: 'serviceUnavailable',
};

/**
 * Documents the given error statuses with the shared problem-details component.
 * A thin alias of `ApiErrorResponses` from `api-error-responses.decorator`, kept
 * for call sites that list statuses instead of naming them.
 */
export function ApiErrorResponses(...statuses: number[]) {
  const options: ApiErrorResponsesOptions = {};
  for (const status of statuses) {
    const key = STATUS_OPTIONS[status];
    if (key) options[key] = true;
  }
  return ApiStandardErrorResponses(options);
}