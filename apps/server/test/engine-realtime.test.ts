import { MemoryFs } from "@kamino/sync-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compactJournal, INACTIVE_DEVICE_MS } from "../src/jobs/compact.js";
import { eventually, liveEngine } from "./helpers/engine.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, raw, user, type TestDevice } from "./helpers/sync.js";

describe.skipIf(dockerUnavailable)("realtime between two engines (M2b)", () => {
  let pg: TestPostgres;
  let url: string;
  let t: TestApp;
  let app: FastifyInstance | null;
  let a: TestDevice;
  let b: TestDevice;
  const dirs = { blobs: "", staging: "" };

  beforeAll(async () => {
    pg = await startPostgres();
    url = await pg.createDatabase("engine_realtime");
    t = await testApp(url, { chunkSize: 64 * 1024 });
    Object.assign(dirs, t.dirs);
    app = t.app;
    const enroll = await user(t, "ada");
    a = await linkDevice(t, enroll, undefined, "Laptop");
    b = await linkDevice(t, enroll, a.vaultId, "Phone");
  });
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });

  it("a change on A reaches B without syncNow", async () => {
    const fsA = new MemoryFs();
    const fsB = new MemoryFs();
    const ea = await liveEngine(() => app, a, fsA);
    const eb = await liveEngine(() => app, b, fsB);
    ea.start();
    eb.start();
    await eventually(() => ea.realtimeConnected && eb.realtimeConnected);
    fsA.put("hello.md", "from A");
    ea.localChange();
    await eventually(() => fsB.text("hello.md") === "from A");
    await ea.stop();
    await eb.stop();
  }, 60_000);

  it("the server restarts: B reconnects and catches up", async () => {
    const fsA = new MemoryFs();
    const fsB = new MemoryFs();
    const eb = await liveEngine(() => app, b, fsB);
    eb.start();
    await eventually(() => eb.realtimeConnected);
    app = null;
    await t.close();
    t = await testApp(url, { chunkSize: 64 * 1024, dirs });
    app = t.app;
    const ea = await liveEngine(() => app, a, fsA);
    fsA.put("after-restart.md", "x");
    await ea.syncNow();
    await eventually(() => fsB.text("after-restart.md") === "x", 30_000);
    await ea.stop();
    await eb.stop();
  }, 90_000);

  it("compaction while B was away: B's socket gets 4410 and resyncs", async () => {
    const fsA = new MemoryFs();
    const fsB = new MemoryFs();
    const eb0 = await liveEngine(() => app, b, fsB);
    await eb0.syncNow();
    await eb0.stop();
    const ea = await liveEngine(() => app, a, fsA);
    fsA.put("while-away.md", "news");
    await ea.syncNow();
    t.clock.now += INACTIVE_DEVICE_MS + 31 * 86_400_000;
    await ea.syncNow();
    expect((await compactJournal(t.db, t.clock.now)).deleted).toBeGreaterThan(0);
    const eb = await liveEngine(() => app, b, fsB);
    eb.start();
    await eventually(() => fsB.text("while-away.md") === "news", 30_000);
    await ea.stop();
    await eb.stop();
  }, 90_000);

  it("B unlinks itself while connected: its engine stops", async () => {
    const fsB = new MemoryFs();
    const eb = await liveEngine(() => app, b, fsB);
    eb.start();
    await eventually(() => eb.realtimeConnected);
    await raw(t, "DELETE", "/device", undefined, { authorization: `Bearer ${b.token}` });
    await eventually(() => eb.stopped === "revoked");
  }, 60_000);
});
