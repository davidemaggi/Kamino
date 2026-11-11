import type { ErrorCode } from "@kamino/protocol";

/** A failure with a catalog code and an HTTP status; the central error handler turns it into a body. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
  ) {
    super(code);
  }
}

export const notFound = () => new ApiError("not_found", 404);
export const notImplemented = () => new ApiError("not_implemented", 501);
