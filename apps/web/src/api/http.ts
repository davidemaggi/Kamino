import { PRODUCT_SLUG } from "@kamino/brand";
import { ErrorBody, type ErrorCode } from "@kamino/protocol";
import type { z } from "zod";

export const API_BASE = "/api/v1";
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Anti-CSRF marker on writes (verified by the server from M1). */
const CSRF_HEADER_VALUE = `${PRODUCT_SLUG}-web`;

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

let unauthorizedHandler: (() => void) | null = null;

/**
 * Called when an API call answers 401 mid-session (spec §4: any 401 → sign-in).
 * /me and /auth/* are excluded: the route guards and the sign-in page handle those.
 */
export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (WRITE_METHODS.has(method)) headers["x-requested-with"] = CSRF_HEADER_VALUE;
  const res = await fetch(new URL(`${API_BASE}${path}`, window.location.origin), {
    method,
    headers,
    credentials: "include",
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (res.ok) return res;
  let code: ErrorCode = res.status === 401 ? "unauthorized" : "internal";
  try {
    const parsed = ErrorBody.safeParse(await res.json());
    if (parsed.success) code = parsed.data.error.code;
  } catch {
    // no JSON body: keep the status-based code
  }
  if (code === "unauthorized" && path !== "/me" && !path.startsWith("/auth/"))
    unauthorizedHandler?.();
  throw new ApiError(code, res.status);
}

/** Typed request: the response must match the schema, otherwise it is an "internal" error. */
export async function request<T>(
  schema: z.ZodType<T>,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const res = await send(path, opts);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError("internal", res.status);
  return parsed.data;
}

export async function requestVoid(path: string, opts: RequestOptions = {}): Promise<void> {
  await send(path, opts);
}
