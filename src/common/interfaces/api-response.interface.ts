/**
 * The single, canonical API response envelope used across every Astroid repo.
 * Success: { success: true, data, meta, requestId }
 * Error:   { success: false, error: { code, message }, requestId }
 */

export interface ApiMeta {
  [key: string]: unknown;
}

export interface PaginationMeta extends ApiMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  /** Opaque cursor for the next page, or `null` when this is the last page. */
  nextCursor: string | null;
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
