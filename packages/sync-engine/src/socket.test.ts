import { PROTOCOL_VERSION, type Hello } from "@kamino/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "./testing/manual-clock.js";
import { Realtime, type RealtimeEvent, type SocketHandlers } from "./socket.js";

interface Conn {
  h: SocketHandlers;
  sent: unknown[];
  closed: number | null;
}

const hello = (): Hello => ({
  type: "hello",
  deviceToken: "tok",
  protocol: { min: 1, max: PROTOCOL_VERSION },
  cursor: 7,
  pluginVersion: "0.1.0",
  platform: "linux",
});

let clock: ManualClock;
let conns: Conn[];
let events: RealtimeEvent[];
let rt: Realtime;

const last = () => conns[conns.length - 1]!;
const server = (msg: unknown) => last().h.onMessage(JSON.stringify(msg));
const welcome = {
  type: "welcome",
  protocol: 1,
  head: 9,
  deviceId: "d",
  serverVersion: "x",
  codename: "Ash",
};

beforeEach(() => {
  clock = new ManualClock();
  conns = [];
  events = [];
  rt = new Realtime({
    clock,
    hello,
    onEvent: (e) => events.push(e),
    socket: (h) => {
      const c: Conn = { h, sent: [], closed: null };
      conns.push(c);
      return {
        send: (d) => c.sent.push(JSON.parse(d)),
        close: (code) => (c.closed = code ?? 1000),
      };
    },
  });
  rt.start();
});

describe("Realtime", () => {
  it("sends hello first, then reports welcome and changes", () => {
    last().h.onOpen();
    expect(last().sent).toEqual([hello()]);
    server(welcome);
    server({ type: "changes", entries: [], head: 12, hasMore: false });
    expect(events).toEqual([
      { type: "connected", head: 9 },
      { type: "changes", head: 12 },
    ]);
    expect(rt.connected).toBe(true);
  });

  it("answers ping with pong and reports settings changes", () => {
    last().h.onOpen();
    server(welcome);
    server({ type: "ping" });
    expect(last().sent.at(-1)).toEqual({ type: "pong" });
    server({
      type: "vault_settings_changed",
      settings: {
        config: {
          base: false,
          appearance: false,
          hotkeys: false,
          pluginList: false,
          plugins: false,
        },
        patterns: [],
      },
    });
    expect(events.at(-1)).toEqual({ type: "settings" });
  });

  it("stops on 4426 (protocol) and never reconnects", async () => {
    last().h.onOpen();
    server(welcome);
    last().h.onClose(4426);
    expect(events.at(-1)).toEqual({ type: "protocol" });
    await clock.advance(3_600_000);
    expect(conns).toHaveLength(1);
  });

  it.each([4401, 4403])(
    "%i alone (a slow hello can cause it) asks the engine to check, and keeps trying (review I1)",
    async (code) => {
      last().h.onOpen();
      last().h.onClose(code);
      expect(events).toContainEqual({ type: "check" });
      expect(events.some((e) => e.type === "revoked" || e.type === "blocked")).toBe(false);
      await clock.advance(1_000);
      expect(conns).toHaveLength(2);
    },
  );

  it("a connection closed right after welcome doesn't reset the backoff (review I3)", async () => {
    for (let i = 0; i < 4; i++) {
      last().h.onOpen();
      server(welcome);
      last().h.onClose(1011);
      await clock.advance(20_000);
    }
    // 1 s, 2 s, 4 s, 8 s... not 1 s every time: the 5th attempt is still waiting after 10 s.
    const n = conns.length;
    last().h.onOpen();
    server(welcome);
    last().h.onClose(1011);
    await clock.advance(10_000);
    expect(conns.length).toBe(n);
  });

  it("a device_revoked message stops it, once", async () => {
    last().h.onOpen();
    server(welcome);
    server({ type: "device_revoked" });
    last().h.onClose(4401);
    expect(events.filter((e) => e.type === "revoked")).toHaveLength(1);
    await clock.advance(3_600_000);
    expect(conns).toHaveLength(1);
  });

  it("4410 asks for a resync and reconnects; 4404 asks the engine to check", async () => {
    last().h.onOpen();
    last().h.onClose(4410);
    expect(events).toContainEqual({ type: "resync" });
    await clock.advance(1_000);
    expect(conns).toHaveLength(2);
    last().h.onClose(4404);
    expect(events).toContainEqual({ type: "check" });
  });

  it("4409 (replaced) waits about 5 minutes before reconnecting", async () => {
    last().h.onOpen();
    server(welcome);
    last().h.onClose(4409);
    await clock.advance(240_000);
    expect(conns).toHaveLength(1);
    await clock.advance(120_000);
    expect(conns).toHaveLength(2);
  });

  it("never reconnects faster than the backoff", async () => {
    for (let i = 0; i < 6; i++) last().h.onClose(1006);
    // 1006 six times in a row from the same connection counts once: one pending reconnect.
    await clock.advance(999);
    expect(conns).toHaveLength(1);
    await clock.advance(1);
    expect(conns).toHaveLength(2);
    last().h.onClose(1006); // second failure: about 2 s
    await clock.advance(1_400);
    expect(conns).toHaveLength(2);
    await clock.advance(1_000);
    expect(conns).toHaveLength(3);
    expect(events.filter((e) => e.type === "disconnected").length).toBeGreaterThan(0);
  });

  it("a connection that worked for a minute resets the backoff", async () => {
    last().h.onClose(1006);
    await clock.advance(1_000);
    last().h.onClose(1006);
    await clock.advance(2_000);
    last().h.onOpen();
    server(welcome);
    for (let i = 0; i < 5; i++) {
      await clock.advance(15_000);
      server({ type: "ping" });
    }
    last().h.onClose(1006);
    await clock.advance(1_000);
    expect(conns).toHaveLength(4);
  });

  it("75 s of silence closes and reconnects", async () => {
    last().h.onOpen();
    server(welcome);
    await clock.advance(60_000);
    expect(last().closed).toBeNull();
    await clock.advance(30_000);
    expect(conns[0]!.closed).not.toBeNull();
    await clock.advance(2_000);
    expect(conns.length).toBeGreaterThan(1);
  });

  it("stop() closes with 1000 and never reconnects", async () => {
    last().h.onOpen();
    server(welcome);
    rt.stop();
    expect(last().closed).toBe(1000);
    last().h.onClose(1000);
    await clock.advance(3_600_000);
    expect(conns).toHaveLength(1);
    expect(rt.connected).toBe(false);
  });
});
