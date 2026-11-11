import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { obsidianSocket } from "./obsidian-socket.js";

class FakeWs {
  static last: FakeWs | null = null;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.last = this;
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code: number) {
    this.onclose?.({ code });
  }
}

const original = globalThis.WebSocket;
beforeEach(() => {
  FakeWs.last = null;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWs;
});
afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = original;
});

const handlers = () => {
  const log: string[] = [];
  return {
    log,
    h: {
      onOpen: () => log.push("open"),
      onMessage: (d: string) => log.push(d),
      onClose: (c: number) => log.push(`close ${c}`),
    },
  };
};

describe("obsidianSocket", () => {
  it("connects to wss://host/path/api/v1/ws and relays messages", () => {
    const { log, h } = handlers();
    const conn = obsidianSocket("https://sync.example.org/kamino/", { mobile: true })(h);
    const ws = FakeWs.last!;
    expect(ws.url).toBe("wss://sync.example.org/kamino/api/v1/ws");
    ws.readyState = 1;
    ws.onopen!();
    conn.send("hi");
    ws.onmessage!({ data: "msg" });
    conn.close(1000);
    expect(ws.sent).toEqual(["hi"]);
    expect(log).toEqual(["open", "msg", "close 1000"]);
  });

  it("uses ws:// for http on desktop, refuses it on mobile", async () => {
    obsidianSocket("http://nas.local:8080", { mobile: false })(handlers().h);
    expect(FakeWs.last!.url).toBe("ws://nas.local:8080/api/v1/ws");
    FakeWs.last = null;
    const { log, h } = handlers();
    obsidianSocket("http://nas.local:8080", { mobile: true })(h);
    await Promise.resolve();
    expect(FakeWs.last).toBeNull();
    expect(log).toEqual(["close 1006"]);
  });
});
