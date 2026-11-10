import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./load.js";

const minimal = {
  KAMINO_PUBLIC_URL: "https://sync.example.com",
  KAMINO_DATABASE_URL: "postgres://u:p@localhost:5432/db",
  KAMINO_MASTER_KEY: "a-master-key",
};

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  throw new Error("expected ConfigError");
}

describe("loadConfig", () => {
  it("storage: fs by default; s3 needs bucket, key id and secret (also from a file)", () => {
    const c = loadConfig(minimal).config;
    expect(c.storage).toEqual({ kind: "fs", dir: "/data/blobs" });
    expect(c.stagingDir).toBe("/data/staging");
    expect(c.maxFileBytes).toBe(500 * 1024 * 1024);
    expect(() => loadConfig({ ...minimal, KAMINO_STORAGE: "s3" })).toThrow(ConfigError);
    const s3 = loadConfig(
      {
        ...minimal,
        KAMINO_STORAGE: "s3",
        KAMINO_S3_BUCKET: "b",
        KAMINO_S3_ACCESS_KEY_ID: "id",
        KAMINO_S3_SECRET_ACCESS_KEY_FILE: "/run/secrets/s3",
        KAMINO_S3_ENDPOINT: "http://minio:9000",
        KAMINO_S3_FORCE_PATH_STYLE: "true",
      },
      () => "s3-secret\n",
    ).config.storage;
    expect(s3).toEqual({
      kind: "s3",
      bucket: "b",
      accessKeyId: "id",
      secretAccessKey: "s3-secret",
      region: "us-east-1",
      forcePathStyle: true,
      endpoint: "http://minio:9000",
    });
    expect(() => loadConfig({ ...minimal, KAMINO_STORAGE: "ftp" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...minimal, KAMINO_MAX_FILE_BYTES: "lots" })).toThrow(ConfigError);
  });

  it("KAMINO_TRUST_PROXY: absent by default, hop count or IP/CIDR list, nothing else", () => {
    expect(loadConfig(minimal).config.trustProxy).toBeUndefined();
    expect(loadConfig({ ...minimal, KAMINO_TRUST_PROXY: "" }).config.trustProxy).toBeUndefined();
    expect(loadConfig({ ...minimal, KAMINO_TRUST_PROXY: "1" }).config.trustProxy).toBe(1);
    expect(
      loadConfig({ ...minimal, KAMINO_TRUST_PROXY: "10.0.0.0/8, 172.16.0.1" }).config.trustProxy,
    ).toEqual(["10.0.0.0/8", "172.16.0.1"]);
    expect(() => loadConfig({ ...minimal, KAMINO_TRUST_PROXY: "true" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...minimal, KAMINO_TRUST_PROXY: "0" })).toThrow(ConfigError);
  });

  it("applies defaults for a minimal valid environment", () => {
    const { config, sources } = loadConfig(minimal);
    expect(config.port).toBe(8080);
    expect(sources.port).toBe("default");
    expect(config.logLevel).toBe("info");
    expect(sources.logLevel).toBe("default");
    expect(sources.publicUrl).toBe("env");
  });

  it("reads a secret from the *_FILE variant", () => {
    const { KAMINO_DATABASE_URL: _omit, ...rest } = minimal;
    void _omit;
    const { config, sources } = loadConfig(
      { ...rest, KAMINO_DATABASE_URL_FILE: "/run/secrets/db" },
      (p) => (p === "/run/secrets/db" ? "postgres://file@h/db\n" : ""),
    );
    expect(config.databaseUrl).toBe("postgres://file@h/db");
    expect(sources.databaseUrl).toBe("file");
  });

  it("rejects a secret set both directly and via *_FILE", () => {
    const issues = issuesOf(() =>
      loadConfig({ ...minimal, KAMINO_DATABASE_URL_FILE: "/run/secrets/db" }, () => "x"),
    );
    expect(issues.join(" ")).toContain("KAMINO_DATABASE_URL");
    expect(issues.join(" ")).toMatch(/only one/i);
  });

  it("reports an unreadable *_FILE as a ConfigError", () => {
    const { KAMINO_MASTER_KEY: _omit, ...rest } = minimal;
    void _omit;
    const issues = issuesOf(() =>
      loadConfig({ ...rest, KAMINO_MASTER_KEY_FILE: "/nope" }, () => {
        throw new Error("ENOENT");
      }),
    );
    expect(issues.join(" ")).toContain("KAMINO_MASTER_KEY_FILE");
  });

  it("treats an empty KAMINO_PUBLIC_URL as unset and names it in the error", () => {
    const issues = issuesOf(() => loadConfig({ ...minimal, KAMINO_PUBLIC_URL: "" }));
    expect(issues.some((i) => i.includes("KAMINO_PUBLIC_URL"))).toBe(true);
  });

  it("treats an empty KAMINO_PORT as unset (default applies)", () => {
    const { config, sources } = loadConfig({ ...minimal, KAMINO_PORT: "" });
    expect(config.port).toBe(8080);
    expect(sources.port).toBe("default");
  });

  it("rejects a non-numeric KAMINO_PORT", () => {
    expect(() => loadConfig({ ...minimal, KAMINO_PORT: "abc" })).toThrow(ConfigError);
  });

  it("rejects an invalid log level and a malformed public URL", () => {
    expect(() => loadConfig({ ...minimal, KAMINO_LOG_LEVEL: "loud" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...minimal, KAMINO_PUBLIC_URL: "not a url" })).toThrow(ConfigError);
  });

  it("collects every issue and never echoes secret values", () => {
    const secretUrl = "postgres://user:s3cr3t-pw-value@h/db";
    const secretKey = "s3cr3t-key-value";
    const issues = issuesOf(() =>
      loadConfig({
        KAMINO_PORT: "abc",
        KAMINO_MASTER_KEY: secretKey,
        KAMINO_MASTER_KEY_FILE: "/run/secrets/k",
        KAMINO_DATABASE_URL: secretUrl,
        KAMINO_DATABASE_URL_FILE: "/run/secrets/d",
        KAMINO_PUBLIC_URL: "not a url",
      }),
    );
    expect(issues.length).toBeGreaterThanOrEqual(4);
    const all = issues.join("\n");
    expect(all).not.toContain("s3cr3t-pw-value");
    expect(all).not.toContain(secretKey);
  });

  it("strips trailing slashes from KAMINO_PUBLIC_URL", () => {
    const { config } = loadConfig({ ...minimal, KAMINO_PUBLIC_URL: "https://sync.example.com//" });
    expect(config.publicUrl).toBe("https://sync.example.com");
  });

  describe("secret files with a byte-order mark", () => {
    const withFile = (buf: Buffer) => {
      const { KAMINO_MASTER_KEY: _omit, ...rest } = minimal;
      void _omit;
      return loadConfig({ ...rest, KAMINO_MASTER_KEY_FILE: "/k" }, () => buf).config.masterKey;
    };
    const key = "abcDEF0123456789abcDEF0123456789abcDEF01234";
    it("decodes UTF-16LE with BOM (Windows PowerShell 5.1 redirection)", () => {
      const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${key}\r\n`, "utf16le")]);
      expect(withFile(buf)).toBe(key);
    });
    it("decodes UTF-16BE with BOM", () => {
      const le = Buffer.from(`${key}\n`, "utf16le");
      const be = Buffer.from(le).swap16();
      expect(withFile(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(key);
    });
    it("strips a UTF-8 BOM", () => {
      const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${key}\n`)]);
      expect(withFile(buf)).toBe(key);
    });
  });
});
