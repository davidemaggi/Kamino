/** Where a configuration value came from ("db" arrives with M5). */
export type ConfigSource = "env" | "file" | "default";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type Config = {
  publicUrl: string;
  port: number;
  databaseUrl: string;
  masterKey: string;
  logLevel: LogLevel;
};

export const DEFAULT_PORT = 8080;
export const DEFAULT_LOG_LEVEL: LogLevel = "info";
