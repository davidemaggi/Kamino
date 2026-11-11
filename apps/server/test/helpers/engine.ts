import { DEFAULT_SYNC_SETTINGS } from "@kamino/protocol";
import {
  Engine,
  MemoryFs,
  type Clock,
  type EngineDeps,
  type Http,
  type SocketFactory,
  type VaultFs,
} from "@kamino/sync-engine";
import type { FastifyInstance } from "fastify";
import type { TestDevice } from "./sync.js";

/** `Http` over `app.inject`; `getApp()` null = the server is down (network error). */
export function injectHttp(getApp: () => FastifyInstance | null): Http {
  return {
    async request(r) {
      const app = getApp();
      if (!app) throw new Error("server down");
      const res = await app.inject({
        method: r.method,
        url: `/api/v1${r.path}`,
        headers: {
          ...r.headers,
          ...(r.json !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(r.json !== undefined
          ? { payload: JSON.stringify(r.json) }
          : r.body
            ? { payload: Buffer.from(r.body) }
            : {}),
      });
      const type = String(res.headers["content-type"] ?? "");
      let json: unknown;
      if (type.includes("json"))
        try {
          json = res.json();
        } catch {
          json = undefined;
        }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = String(v);
      return {
        status: res.statusCode,
        ...(json !== undefined ? { json } : {}),
        body: new Uint8Array(res.rawPayload),
        headers,
      };
    },
  };
}

/** Time stands still and sleeps never end: cycles run only through `syncNow()`. */
export const stillClock = (): Clock => ({
  now: () => Date.UTC(2026, 10, 9, 12),
  sleep: () => new Promise<void>(() => {}),
  random: () => 0.5,
});

let ids = 0;

/** A sync engine for `device`, on `fs`, talking to the app returned by `getApp`. */
export function deviceEngine(
  getApp: () => FastifyInstance | null,
  device: TestDevice,
  fs: VaultFs = new MemoryFs(),
  http: Http = injectHttp(getApp),
): Promise<Engine> {
  return Engine.open({
    fs,
    http,
    clock: stillClock(),
    newId: () => `e${process.pid}-${Date.now().toString(36)}-${++ids}`,
    vaultId: device.vaultId,
    token: () => device.token,
    config: {
      deviceId: device.deviceId,
      platform: "linux",
      configDir: ".obsidian",
      settings: DEFAULT_SYNC_SETTINGS,
      batchSize: 200,
    },
  });
}

/** Local files outside the configuration folder: path → text. */
export function vaultFiles(fs: MemoryFs): Map<string, string> {
  return new Map(
    [...fs.files.keys()]
      .filter((p) => !p.startsWith(".obsidian/"))
      .sort()
      .map((p) => [p, fs.text(p)!]),
  );
}

/** A realtime socket over `app.injectWS`; `getApp()` null = server down (closes with 1006). */
export function injectSocket(getApp: () => FastifyInstance | null): SocketFactory {
  return (h) => {
    let ws: { send(d: string): void; close(code?: number): void; terminate(): void } | null = null;
    let closed = false;
    const app = getApp();
    if (!app) {
      queueMicrotask(() => h.onClose(1006));
      return { send() {}, close() {} };
    }
    void app
      .ready()
      .then(() => app.injectWS("/api/v1/ws"))
      .then(
        (socket) => {
          if (closed) {
            socket.terminate();
            return;
          }
          ws = socket;
          socket.on("message", (d) => h.onMessage(String(d)));
          socket.on("close", (code) => h.onClose(code));
          h.onOpen();
        },
        () => h.onClose(1006),
      );
    return {
      send: (d) => ws?.send(d),
      close: (code) => {
        closed = true;
        ws?.close(code ?? 1000);
      },
    };
  };
}

/** Real time: reconnections and timers actually happen. */
export const realClock = (): Clock => ({
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: () => Math.random(),
});

/** An engine in Live mode with a realtime socket. */
export function liveEngine(
  getApp: () => FastifyInstance | null,
  device: TestDevice,
  fs: VaultFs,
  extra: Partial<EngineDeps> = {},
): Promise<Engine> {
  return Engine.open({
    fs,
    http: injectHttp(getApp),
    socket: injectSocket(getApp),
    client: { pluginVersion: "0.1.0", platform: "linux" },
    clock: realClock(),
    newId: () => `l${process.pid}-${Date.now().toString(36)}-${++ids}`,
    vaultId: device.vaultId,
    token: () => device.token,
    config: {
      deviceId: device.deviceId,
      platform: "linux",
      configDir: ".obsidian",
      settings: DEFAULT_SYNC_SETTINGS,
      batchSize: 200,
    },
    mode: { mode: "live", periodicMinutes: 15 },
    ...extra,
  });
}

/** Waits until `ok()` holds (polling), or fails after `ms`. */
export async function eventually(ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}
