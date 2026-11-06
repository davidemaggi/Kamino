import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { buildInfo } from "../src/build-info.js";
import type { Config } from "../src/config/schema.js";
import { createDb } from "../src/db/client.js";

const config: Config = {
  publicUrl: "http://localhost:8080",
  port: 8080,
  databaseUrl: "unused",
  masterKey: "unused",
  logLevel: "error",
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
    app = buildApp({ config, db, logger, buildInfo, webRoot: root });
    bare = buildApp({
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
});
