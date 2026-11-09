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
  /**
   * Proxies whose X-Forwarded-For is trusted: a hop count or IP/CIDR list. Absent = none: the
   * client address is the TCP peer, so a client can't spoof its IP to dodge rate limits.
   */
  trustProxy?: number | string[];
};

export const DEFAULT_PORT = 8080;
export const DEFAULT_LOG_LEVEL: LogLevel = "info";
