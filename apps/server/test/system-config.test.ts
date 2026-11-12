import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { auditLog, systemConfig } from "../src/db/schema.js";
import { ApiError } from "../src/http/errors.js";
import { SystemConfigService } from "../src/system/config.js";
import { kek } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";

const base: Config = {
  publicUrl: "http://localhost:8080",
  port: 0,
  databaseUrl: "",
  masterKey: "",
  logLevel: "error",
  storage: { kind: "fs", dir: "/tmp/x" },
  stagingDir: "/tmp/y",
  maxFileBytes: 1_000_000,
};

describe.skipIf(dockerUnavailable)("system config", () => {
  let pg: TestPostgres;
  let db: Db;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => {
    await db?.$client.end();
    await pg?.stop();
  });
  beforeEach(async () => {
    await db?.$client.end();
    db = createDb(await pg.createDatabase(`sc_${++n}`));
    await runMigrations(db, async () => undefined);
  });

  it("defaults, each with source 'default'", async () => {
    const c = await new SystemConfigService(db, base, kek).get();
    expect(c.registration).toEqual({ value: "closed", source: "default" });
    expect(c.defaultQuotaBytes).toEqual({ value: null, source: "default" });
    expect(c.maxRetentionDays).toEqual({ value: 90, source: "default" });
    expect(c.maxFileBytes).toEqual({ value: 1_000_000, source: "default" });
    expect(c.smtp.passwordSet).toBe(false);
    expect(c.smtpConfigured).toBe(false);
    expect(await new SystemConfigService(db, base, kek).smtp()).toBeNull();
  });

  it("a UI value wins over the default and is audited with old and new value", async () => {
    const s = new SystemConfigService(db, base, kek);
    const c = await s.patch({ registration: "open", defaultQuotaBytes: 5000 }, "root");
    expect(c.registration).toEqual({ value: "open", source: "ui" });
    expect(c.defaultQuotaBytes).toEqual({ value: 5000, source: "ui" });
    expect(await s.effective()).toMatchObject({ registration: "open", defaultQuotaBytes: 5000 });
    const audit = await db.select().from(auditLog);
    expect(audit.map((a) => [a.actor, a.action, a.target]).sort()).toEqual([
      ["root", "config_changed", "defaultQuotaBytes: none → 5000"],
      ["root", "config_changed", "registration: closed → open"],
    ]);
  });

  it("an environment value wins and locks the field: patch → 409 config_locked", async () => {
    const s = new SystemConfigService(
      db,
      { ...base, system: { registration: "open", smtp: { password: "env-pw" } } },
      kek,
    );
    await db.insert(systemConfig).values({ key: "registration", value: "closed" });
    const c = await s.get();
    expect(c.registration).toEqual({ value: "open", source: "env" });
    expect(c.smtp.passwordSource).toBe("env");
    for (const p of [{ registration: "closed" as const }, { smtp: { password: "x" } }]) {
      const e = await s.patch(p, "root").catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("config_locked");
      expect((e as ApiError).status).toBe(409);
    }
    // All or nothing: a free field in the same patch is not written either.
    await s.patch({ maxRetentionDays: 10, registration: "closed" }, "root").catch(() => undefined);
    expect((await s.get()).maxRetentionDays.source).toBe("default");
  });

  it("the SMTP password is stored encrypted, never returned and never audited", async () => {
    const s = new SystemConfigService(db, base, kek);
    const c = await s.patch(
      { smtp: { host: "smtp.example.com", from: "noreply@example.com", password: "s3cret-pw" } },
      "root",
    );
    expect(c.smtp.passwordSet).toBe(true);
    expect(c.smtp.passwordSource).toBe("ui");
    expect(c.smtpConfigured).toBe(true);
    expect(JSON.stringify(c)).not.toContain("s3cret-pw");
    const rows = await db.select().from(systemConfig);
    expect(JSON.stringify(rows.map((r) => [r.key, r.value]))).not.toContain("s3cret-pw");
    expect(rows.find((r) => r.key === "smtp.password")!.secretEnc!.includes("s3cret-pw")).toBe(
      false,
    );
    const audit = await db.select().from(auditLog);
    expect(JSON.stringify(audit)).not.toContain("s3cret-pw");
    expect(audit.some((a) => a.target === "smtp.password")).toBe(true);
    expect(await s.smtp()).toMatchObject({ host: "smtp.example.com", password: "s3cret-pw" });
    // An empty password clears it.
    expect((await s.patch({ smtp: { password: "" } }, "root")).smtp.passwordSet).toBe(false);
  });

  it("an empty environment string is unset (loader) so the UI value applies", async () => {
    const { loadConfig } = await import("../src/config/load.js");
    const { config } = loadConfig({
      KAMINO_PUBLIC_URL: "http://localhost:8080",
      KAMINO_DATABASE_URL: "postgres://x",
      KAMINO_MASTER_KEY: "k",
      KAMINO_REGISTRATION: "",
    });
    const s = new SystemConfigService(db, config, kek);
    expect((await s.patch({ registration: "open" }, "root")).registration).toEqual({
      value: "open",
      source: "ui",
    });
  });
});
