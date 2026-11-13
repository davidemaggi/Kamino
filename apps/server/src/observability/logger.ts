import { pino, type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "../config/schema.js";

export type { Logger };

/** Never log keys, tokens or credentials (see global constraints). */
export const REDACT_PATHS = [
  "masterKey",
  "*.masterKey",
  "masterKeyPrevious",
  "*.masterKeyPrevious",
  "token",
  "*.token",
  "password",
  "*.password",
  "databaseUrl",
  "*.databaseUrl",
  "headers.authorization",
  "headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
];

/** One-time tokens travel in some URLs (invitations, resets, exports): never let them reach the logs. */
export function redactUrl(url: string): string {
  return url
    .replace(/(\/(?:invites|invite|reset|exports)\/)[^/?#]+/g, "$1[token]")
    .replace(/([?&]token=)[^&#]*/g, "$1[token]");
}

const serializers = {
  req: (req: { method?: string; url?: string; hostname?: string; ip?: string }) => ({
    method: req.method,
    url: req.url === undefined ? undefined : redactUrl(req.url),
    hostname: req.hostname,
    remoteAddress: req.ip,
  }),
};

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS }, serializers }, destination);
}
