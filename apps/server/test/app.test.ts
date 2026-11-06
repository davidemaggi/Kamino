import { PROTOCOL_MIN_SUPPORTED, PROTOCOL_VERSION, VersionInfo } from "@kamino/protocol";
import { createServer, type Server, type Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { buildInfo } from "../src/build-info.js";
import type { Config } from "../src/config/schema.js";
import { createDb, type Db } from "../src/db/client.js";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";

const config: Config = {
  publicUrl: "http://localhost:8080",
  port: 8080,
  databaseUrl: "unused",
  masterKey: "unused",
  logLevel: "error",
};
const logger = pino({ level: "silent" });

describe("app", () => {
  let pg: TestPostgres;
  let upDb: Db;
  let downDb: Db;
  let up: FastifyInstance;
  let down: FastifyInstance;
  let hangDb: Db;
  let hang: FastifyInstance;
  let hangServer: Server;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    pg = await startPostgres();
    upDb = createDb(await pg.createDatabase("app_up"));
    // Port 1 is closed: the connection is refused.
    downDb = createDb("postgres://u:p@127.0.0.1:1/none");
    // Accepts TCP connections but never answers the Postgres handshake.
    hangServer = createServer((socket) => {
      sockets.add(socket);
    });
    await new Promise<void>((r) => hangServer.listen(0, "127.0.0.1", r));
    const addr = hangServer.address();
    const hangPort = typeof addr === "object" && addr ? addr.port : 0;
    hangDb = createDb(`postgres://u:p@127.0.0.1:${hangPort}/none`);
    hang = buildApp({ config, db: hangDb, logger, buildInfo });
    up = buildApp({ config, db: upDb, logger, buildInfo });
    down = buildApp({ config, db: downDb, logger, buildInfo });
  });

  afterAll(async () => {
    await up?.close();
    await down?.close();
    await upDb?.$client.end({ timeout: 1 });
    await downDb?.$client.end({ timeout: 1 });
    await hang?.close();
    await hangDb?.$client.end({ timeout: 1 });
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => (hangServer ? hangServer.close(() => r()) : r()));
    await pg?.stop();
  });

  it("GET /health/live returns 200", async () => {
    const res = await up.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /health/ready returns 200 when the database is up", async () => {
    const res = await up.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checks: { database: "up" } });
  });

  it("GET /health/ready returns 503 within 2s when the database is unreachable", async () => {
    const started = Date.now();
    const res = await down.inject({ method: "GET", url: "/health/ready" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable", checks: { database: "down" } });
  });

  it("GET /health/ready returns 503 within 2s when the database accepts but never answers", async () => {
    const started = Date.now();
    const res = await hang.inject({ method: "GET", url: "/health/ready" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable", checks: { database: "down" } });
  });

  it("GET /version returns a valid VersionInfo with the Ash codename", async () => {
    const res = await up.inject({ method: "GET", url: "/version" });
    expect(res.statusCode).toBe(200);
    const info = VersionInfo.parse(res.json());
    expect(info.codename).toBe("Ash");
    expect(info.protocol).toEqual({ min: PROTOCOL_MIN_SUPPORTED, max: PROTOCOL_VERSION });
  });
});
