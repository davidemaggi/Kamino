import { DEFAULT_SYNC_SETTINGS } from "@kamino/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Engine, type EngineDeps } from "./engine.js";
import { MemoryFs } from "./memory-fs.js";
import { FakeServer } from "./testing/fake-server.js";
import { ManualClock } from "./testing/manual-clock.js";

const DEV = "dev-a";
let ids = 0;
function deps(
  server: FakeServer,
  fs: MemoryFs,
  clock = new ManualClock(),
  extra: Partial<EngineDeps> = {},
): EngineDeps {
  return {
    fs,
    http: server.http(DEV),
    socket: server.socket(DEV),
    client: { pluginVersion: "0.1.0", platform: "linux" },
    clock,
    newId: () => `rt-${++ids}`,
    config: {
      deviceId: DEV,
      platform: "linux",
      configDir: ".obsidian",
      settings: DEFAULT_SYNC_SETTINGS,
      batchSize: 50,
    },
    vaultId: "v",
    token: () => DEV,
    ...extra,
  };
}

/** Lets queued microtasks and the engine's cycles run. */
async function settle(e: Engine, clock: ManualClock, ms = 0) {
  for (let i = 0; i < 5; i++) {
    await clock.advance(ms);
    await e.syncNow();
  }
}

const remote = (server: FakeServer, n: number, text = `remote ${n}`) =>
  server.remotePut(
    "dev-b",
    {
      opId: `o${n}-${text}`,
      fileId: `f${n}`,
      versionId: `v${n}-${text}`,
      path: `r${n}.md`,
      baseVersionId: null,
      mtime: 1,
    },
    text,
  );

describe("engine and realtime notifications", () => {
  it("a remote change arrives without syncNow", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    const clock = new ManualClock();
    const e = await Engine.open(deps(server, fs, clock));
    e.start();
    await settle(e, clock);
    expect(e.realtimeConnected).toBe(true);
    await remote(server, 1);
    // No syncNow: only the notification drives the pull.
    for (let i = 0; i < 50 && fs.text("r1.md") === undefined; i++) await clock.advance(0);
    expect(fs.text("r1.md")).toBe("remote 1");
    await e.stop();
  });

  it("notifications not beyond the cursor don't pull; a burst makes at most one more pull", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    const clock = new ManualClock();
    const e = await Engine.open(deps(server, fs, clock));
    e.start();
    await settle(e, clock);
    const before = server.pulls;
    server.notify(); // head unchanged
    await settle(e, clock);
    expect(server.pulls - before).toBeLessThanOrEqual(5); // only the settle() cycles
    const base = server.pulls;
    for (let i = 0; i < 10; i++) {
      server.duplicateNext();
      await remote(server, 100 + i);
    }
    for (let i = 0; i < 50; i++) await clock.advance(0);
    await e.syncNow();
    expect(server.pulls - base).toBeLessThan(10);
    expect(fs.files.size).toBe(10);
    await e.stop();
  });

  it("pulls after every (re)connection", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    const clock = new ManualClock();
    const e = await Engine.open(deps(server, fs, clock));
    e.start();
    await settle(e, clock);
    server.closeAll(1006);
    server.dropNext();
    await remote(server, 1); // the notification is lost while disconnected
    await clock.advance(1_500); // reconnect after the backoff
    for (let i = 0; i < 50 && fs.text("r1.md") === undefined; i++) await clock.advance(0);
    expect(fs.text("r1.md")).toBe("remote 1");
    await e.stop();
  });

  it.each([
    [4401, "revoked"],
    [4403, "blocked"],
    [4426, "protocol"],
  ] as const)("a close %i stops the engine (%s)", async (code, why) => {
    const server = new FakeServer();
    const clock = new ManualClock();
    const e = await Engine.open(deps(server, new MemoryFs(), clock));
    e.start();
    await settle(e, clock);
    server.closeAll(code);
    for (let i = 0; i < 20; i++) await clock.advance(0);
    expect(e.stopped).toBe(why);
  });

  it("4404: checks via REST and stops if the device is gone", async () => {
    const server = new FakeServer();
    const clock = new ManualClock();
    const e = await Engine.open(deps(server, new MemoryFs(), clock));
    e.start();
    await settle(e, clock);
    server.revoked = true;
    server.closeAll(4404);
    for (let i = 0; i < 20; i++) await clock.advance(0);
    expect(e.stopped).toBe("revoked");
  });

  it("4410: resyncs from the snapshot", async () => {
    const server = new FakeServer();
    const fs = new MemoryFs();
    const clock = new ManualClock();
    const e = await Engine.open(deps(server, fs, clock));
    e.start();
    await settle(e, clock);
    server.dropNext();
    await remote(server, 1);
    server.floor = server.store.head;
    server.closeAll(4410);
    await settle(e, clock, 1_500);
    expect(fs.text("r1.md")).toBe("remote 1");
  });

  it("a settings message asks the host to reload the settings", async () => {
    const server = new FakeServer();
    const clock = new ManualClock();
    let told = 0;
    const e = await Engine.open(
      deps(server, new MemoryFs(), clock, { onSettingsChanged: () => told++ }),
    );
    e.start();
    await settle(e, clock);
    (server as unknown as { sockets: Set<{ h: { onMessage(d: string): void } }> }).sockets.forEach(
      (s) =>
        s.h.onMessage(
          JSON.stringify({ type: "vault_settings_changed", settings: DEFAULT_SYNC_SETTINGS }),
        ),
    );
    expect(told).toBe(1);
    await e.stop();
  });
});

describe("realtime properties", () => {
  it("lost, duplicated notifications and dropped sockets never prevent convergence", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({
              t: fc.constant("remote" as const),
              n: fc.nat(4),
              text: fc.string({ maxLength: 6 }),
            }),
            fc.record({
              t: fc.constant("local" as const),
              n: fc.nat(4),
              text: fc.string({ maxLength: 6 }),
            }),
            fc.constant({ t: "drop" as const }),
            fc.constant({ t: "dup" as const }),
            fc.record({
              t: fc.constant("close" as const),
              code: fc.constantFrom(1006, 1011, 4408, 4409, 4410),
            }),
            fc.record({
              t: fc.constant("wait" as const),
              ms: fc.integer({ min: 0, max: 400_000 }),
            }),
          ),
          { maxLength: 20 },
        ),
        async (cmds) => {
          const server = new FakeServer();
          const fs = new MemoryFs();
          const clock = new ManualClock();
          const e = await Engine.open(deps(server, fs, clock));
          e.start();
          await settle(e, clock);
          const versions = new Map<number, { fileId: string; versionId: string }>();
          let k = 0;
          for (const c of cmds) {
            if (c.t === "remote") {
              const prev = versions.get(c.n);
              const live = prev && server.store.files.get(prev.fileId)?.deleted === false;
              const fileId = live ? prev.fileId : `rf-${c.n}-${++k}`;
              const versionId = `rv-${++k}`;
              await server.remotePut(
                "dev-b",
                {
                  opId: `ro-${++k}`,
                  fileId,
                  versionId,
                  path: `r${c.n}.md`,
                  baseVersionId: live ? prev.versionId : null,
                  mtime: 1,
                },
                c.text,
              );
              if (server.store.files.get(fileId)?.headVersionId === versionId)
                versions.set(c.n, { fileId, versionId });
            } else if (c.t === "local") {
              fs.put(`l${c.n}.md`, c.text);
              e.localChange();
            } else if (c.t === "drop") server.dropNext();
            else if (c.t === "dup") server.duplicateNext();
            else if (c.t === "close") server.closeAll(c.code);
            else await clock.advance(c.ms);
            await clock.advance(0);
          }
          await clock.advance(400_000);
          await settle(e, clock);
          const local = new Map(
            [...fs.files.keys()]
              .filter((p) => !p.startsWith(".obsidian/"))
              .map((p) => [p, fs.text(p)!]),
          );
          expect(local).toEqual(server.files());
          await e.stop();
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);
});
