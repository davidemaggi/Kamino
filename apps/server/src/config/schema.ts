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
  /** Where encrypted blobs live (C2). */
  storage:
    | { kind: "fs"; dir: string }
    | {
        kind: "s3";
        endpoint?: string;
        bucket: string;
        region: string;
        accessKeyId: string;
        secretAccessKey: string;
        forcePathStyle: boolean;
      };
  /** Local directory for upload chunks, already encrypted (C6). */
  stagingDir: string;
  maxFileBytes: number;
};

export const DEFAULT_STORAGE_DIR = "/data/blobs";
export const DEFAULT_STAGING_DIR = "/data/staging";
export const DEFAULT_MAX_FILE_BYTES = 500 * 1024 * 1024;

export const DEFAULT_PORT = 8080;
export const DEFAULT_LOG_LEVEL: LogLevel = "info";
