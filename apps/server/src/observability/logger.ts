import { pino, type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "../config/schema.js";

export type { Logger };

/** Never log keys, tokens or credentials (see global constraints). */
export const REDACT_PATHS = [
  "masterKey",
  "*.masterKey",
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

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS } }, destination);
}
