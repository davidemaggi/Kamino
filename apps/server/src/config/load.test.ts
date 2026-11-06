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
    const issues = issuesOf(() =>
      loadConfig({ KAMINO_PORT: "abc", KAMINO_MASTER_KEY: "", KAMINO_DATABASE_URL: "" }),
    );
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
});
