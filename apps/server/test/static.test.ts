import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { buildInfo } from "../src/build-info.js";
import { parseMasterKey } from "../src/crypto/keyring.js";

const kek = parseMasterKey(Buffer.alloc(32, 5).toString("base64"));
import type { Config } from "../src/config/schema.js";
import { createDb } from "../src/db/client.js";

const config: Config = {
  publicUrl: "http://localhost:8080",
  port: 8080,
  databaseUrl: "unused",
  masterKey: "unused",
  logLevel: "error",
  storage: { kind: "fs", dir: "/tmp/kamino-test-blobs" },
  stagingDir: "/tmp/kamino-test-staging",
  maxFileBytes: 1_000_000,
};
const logger = pino({ level: "silent" });
const INDEX = "<!doctype html><title>spa</title>";

describe("web static serving", () => {
  let root: string;
  let app: FastifyInstance;
  let bare: FastifyInstance;
  const db = createDb("postgres://u:p@127.0.0.1:1/none");

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "web-root-"));
    writeFileSync(join(root, "index.html"), INDEX);
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
    app = await buildApp({ kek, config, db, logger, buildInfo, webRoot: root });
    bare = await buildApp({
      kek,
      config,
      db,
      logger,
      buildInfo,
      webRoot: join(root, "does-not-exist"),
    });
    await app.ready();
    await bare.ready();
  });

  afterAll(async () => {
    await app?.close();
    await bare?.close();
    await db.$client.end({ timeout: 1 });
    rmSync(root, { recursive: true, force: true });
  });

  it("serves index.html at /", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
  });

  it("serves real files", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("console.log(1)");
  });

  it("falls back to index.html for client routes", async () => {
    const res = await app.inject({ method: "GET", url: "/some/client/route" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
  });

  it("returns 404 for missing files instead of the SPA shell", async () => {
    for (const url of ["/assets/x.js", "/assets/missing-abc123.js", "/favicon.png"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain("<title>spa</title>");
    }
  });

  it("falls back for HEAD on client routes", async () => {
    const res = await app.inject({ method: "HEAD", url: "/some/client/route" });
    expect(res.statusCode).toBe(200);
  });

  it("keeps API routes working", async () => {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    const version = await app.inject({ method: "GET", url: "/version" });
    expect(version.statusCode).toBe(200);
    expect(version.json()).toMatchObject({ version: buildInfo.version });
  });

  it("does not fall back for API-like paths or non-GET", async () => {
    for (const url of ["/api/nope", "/health/nope", "/version/x"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers["content-type"], url).toMatch(/json/);
    }
    const post = await app.inject({ method: "POST", url: "/some/route" });
    expect(post.statusCode).toBe(404);
  });

  it("starts without static routes when the directory is missing", async () => {
    expect((await bare.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
    expect((await bare.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
  });

  describe("security headers (M7a A1)", () => {
    it("the web app gets a strict CSP and the usual headers", async () => {
      const res = await app.inject({ method: "GET", url: "/" });
      const csp = String(res.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe/);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
      // Plain HTTP (LAN scenario): no HSTS.
      expect(res.headers["strict-transport-security"]).toBeUndefined();
    });

    it("API answers are never cached, errors included", async () => {
      const res = await app.inject({ method: "GET", url: "/api/nothing-here" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      const ok = await app.inject({ method: "GET", url: "/version" });
      expect(ok.headers["cache-control"]).toBe("no-store");
    });

    it("HSTS only behind an HTTPS public URL", async () => {
      const https = await buildApp({
        kek,
        config: { ...config, publicUrl: "https://sync.example.com" },
        db,
        logger,
        buildInfo,
        webRoot: root,
      });
      try {
        const res = await https.inject({ method: "GET", url: "/" });
        expect(res.headers["strict-transport-security"]).toBe("max-age=31536000");
      } finally {
        await https.close();
      }
    });
  });
});
