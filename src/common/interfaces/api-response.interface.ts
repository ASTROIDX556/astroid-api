/**
 * The single, canonical API response envelope used across every Astroid repo.
 * Success: { success: true, data, meta, requestId }
 * Error:   { success: false, error: { code, message }, requestId }
 */

export interface ApiMeta {
  [key: string]: unknown;
}

export interface PaginationMeta extends ApiMeta {
  /** Zero-based row offset of the first item in `data`. */
  offset: number;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  meta: ApiMeta;
  requestId: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorBody;
  requestId: string;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/** Marker used by the response interceptor to carry meta out of a service. */
export class Paginated<T> {
  constructor(
    public readonly items: T[],
    public readonly meta: PaginationMeta,
  ) {}
}
