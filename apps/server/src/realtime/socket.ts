import {
  ClientMessage,
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION,
  WS_PAGE,
  type DeviceStatusReport,
  type JournalEntry,
  type ServerMessage,
  type SyncSettings,
} from "@kamino/protocol";
import { eq } from "drizzle-orm";
import type { WebSocket } from "ws";
import type { BuildInfo } from "../build-info.js";
import type { Db } from "../db/client.js";
import { devices } from "../db/schema.js";
import { findDeviceById, findDeviceByToken } from "../devices/auth.js";
import { recordStatus } from "../devices/status.js";
import { CursorTooOld, type SyncService } from "../sync/commit.js";
import type { VaultService } from "../vaults/service.js";
import type { VaultCrypto } from "../vaults/vault-crypto.js";
import type { Conn, Hub } from "./hub.js";

/** Close codes (4000–4999 are the application's). */
export const CLOSE = {
  invalid: 4400,
  unauthorized: 4401,
  forbidden: 4403,
  notFound: 4404,
  silent: 4408,
  cursorTooOld: 4410,
  protocol: 4426,
  internal: 1011,
} as const;

export interface SocketDeps {
  db: Db;
  hub: Hub;
  sync: SyncService;
  vaults: VaultService;
  buildInfo: BuildInfo;
  /** Current vault settings, for the `vault_settings_changed` message (Task 11). */
  settingsOf?: (vaultId: string) => Promise<SyncSettings>;
  helloMs: number;
  heartbeatMs: number;
  now: () => number;
}

/** Frames a client may pipeline behind hello before welcome. */
const EARLY_MAX = 20;

const err = (code: Extract<ServerMessage, { type: "error" }>["code"]): ServerMessage => ({
  type: "error",
  code,
  message: code,
});

/** One device socket: waiting for hello → live (catch-up, then push) → closed (03 §7). */
export class DeviceSocket implements Conn {
  vaultId = "";
  deviceId = "";
  userId = "";
  /** waiting → authenticating (first hello only) → live (after welcome) → closed. */
  private state: "waiting" | "authenticating" | "live" | "closed" = "waiting";
  /** Frames pipelined behind hello, handled after welcome (bounded). */
  private readonly early: ClientMessage[] = [];
  /** Coalesced writes: one in flight, the latest value waits. */
  private ackWrite: { running: boolean; next: number | null } = { running: false, next: null };
  private statusWrite: { running: boolean; next: DeviceStatusReport | null } = {
    running: false,
    next: null,
  };
  private lastTouch = 0;
  private vc: VaultCrypto | undefined;
  /** Last seq sent to the client. */
  private sent = 0;
  private pumping = false;
  private dirty = false;
  /** Liveness uses the real clock: the app clock may be frozen in tests. */
  private lastHeard = Date.now();
  private readonly helloTimer: NodeJS.Timeout;
  private beat: NodeJS.Timeout | undefined;

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: SocketDeps,
  ) {
    this.helloTimer = setTimeout(() => this.close(CLOSE.unauthorized), deps.helloMs);
    ws.on("message", (data, isBinary) => {
      void this.onMessage(data, isBinary).catch((e: unknown) => this.fail(e));
    });
    ws.on("close", () => this.dispose());
    ws.on("error", () => this.dispose());
  }

  wake(): void {
    if (this.state === "live") void this.pump().catch((e: unknown) => this.fail(e));
  }

  push(message: ServerMessage): void {
    if (this.state === "live") void this.send(message);
  }

  close(code: number, message?: ServerMessage): void {
    if (this.state === "closed") return;
    this.dispose();
    if (this.ws.readyState === this.ws.OPEN) {
      if (message) this.ws.send(JSON.stringify(message));
      this.ws.close(code);
    }
  }

  private dispose(): void {
    this.state = "closed";
    clearTimeout(this.helloTimer);
    if (this.beat) clearInterval(this.beat);
    this.deps.hub.remove(this);
  }

  /** Resolves when the frame has been handed to the socket: one page at a time (backpressure). */
  private send(msg: ServerMessage): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState !== this.ws.OPEN) return resolve();
      this.ws.send(JSON.stringify(msg), () => resolve());
    });
  }

  private fail(e: unknown): void {
    if (e instanceof CursorTooOld) return this.close(CLOSE.cursorTooOld, err("cursor_too_old"));
    this.close(CLOSE.internal, err("internal"));
  }

  private async onMessage(data: unknown, isBinary: boolean): Promise<void> {
    this.lastHeard = Date.now();
    let parsed: unknown;
    try {
      parsed = isBinary ? undefined : JSON.parse(String(data));
    } catch {
      parsed = undefined;
    }
    const m = ClientMessage.safeParse(parsed);
    if (!m.success) return this.close(CLOSE.invalid, err("invalid_request"));
    const msg = m.data;
    if (this.state === "waiting") {
      if (msg.type !== "hello") return this.close(CLOSE.unauthorized, err("unauthorized"));
      // Synchronously: later frames can't start another token lookup.
      this.state = "authenticating";
      return this.hello(msg);
    }
    if (this.state === "authenticating") {
      if (msg.type === "hello" || this.early.length >= EARLY_MAX)
        return this.close(CLOSE.invalid, err("invalid_request"));
      this.early.push(msg);
      return;
    }
    if (this.state !== "live") return;
    return this.handle(msg);
  }

  private async handle(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "hello":
        return this.close(CLOSE.invalid, err("invalid_request"));
      case "ack":
        this.ackWrite.next = Math.max(this.ackWrite.next ?? 0, msg.seq);
        await this.touch();
        return this.flushAck();
      case "status":
        this.statusWrite.next = {
          pendingOps: msg.pendingOps,
          pendingBytes: msg.pendingBytes,
          deferredFiles: msg.deferredFiles,
          ...(msg.lastErrorCode ? { lastErrorCode: msg.lastErrorCode } : {}),
        };
        return this.flushStatus();
      case "ping":
        return this.send({ type: "pong" });
      case "pong":
        return;
    }
  }

  /** A flood of acks becomes one write at a time, always with the highest seq. */
  private async flushAck(): Promise<void> {
    if (this.ackWrite.running) return;
    this.ackWrite.running = true;
    try {
      while (this.ackWrite.next !== null) {
        const seq = this.ackWrite.next;
        this.ackWrite.next = null;
        await this.deps.sync.ack(this.deviceId, this.vaultId, seq);
      }
    } finally {
      this.ackWrite.running = false;
    }
  }

  private async flushStatus(): Promise<void> {
    if (this.statusWrite.running) return;
    this.statusWrite.running = true;
    try {
      while (this.statusWrite.next !== null) {
        const r = this.statusWrite.next;
        this.statusWrite.next = null;
        await recordStatus(this.deps.db, this.deviceId, r, this.deps.now);
      }
    } finally {
      this.statusWrite.running = false;
    }
  }

  /** "Last seen" follows a connected device too (like deviceGuard: at most once a minute). */
  private async touch(): Promise<void> {
    if (Date.now() - this.lastTouch < 60_000) return;
    this.lastTouch = Date.now();
    await this.deps.db
      .update(devices)
      .set({ lastSeenAt: new Date(this.deps.now()) })
      .where(eq(devices.id, this.deviceId));
  }

  private async hello(msg: Extract<ClientMessage, { type: "hello" }>): Promise<void> {
    // The hello timer keeps running until welcome: a stuck lookup can't hold the socket open.
    const lo = Math.max(msg.protocol.min, PROTOCOL_MIN_SUPPORTED);
    const hi = Math.min(msg.protocol.max, PROTOCOL_VERSION);
    if (lo > hi) return this.close(CLOSE.protocol, err("protocol_unsupported"));
    const row = await findDeviceByToken(this.deps.db, msg.deviceToken);
    if (!row) return this.close(CLOSE.unauthorized, err("unauthorized"));
    if (row.d.revokedAt) return this.close(CLOSE.forbidden, { type: "device_revoked" });
    if (row.status !== "active") return this.close(CLOSE.forbidden, err("user_blocked"));
    const v = await this.deps.vaults.byId(row.d.vaultId);
    if (!v || v.status !== "active") return this.close(CLOSE.notFound, err("not_found"));
    if (this.state !== "authenticating") return; // closed while we were looking it up
    this.vaultId = v.id;
    this.deviceId = row.d.id;
    this.userId = row.d.userId;
    this.vc = this.deps.vaults.cryptoOf(v);
    this.sent = msg.cursor;
    // In the hub before welcome, so no notification is missed; wakes before welcome are
    // covered by the first pump below, which reads everything after the cursor.
    this.deps.hub.add(this);
    await this.touch();
    if (this.state !== "authenticating") return;
    clearTimeout(this.helloTimer);
    await this.send({
      type: "welcome",
      protocol: hi,
      head: v.headSeq,
      deviceId: this.deviceId,
      serverVersion: this.deps.buildInfo.version,
      codename: this.deps.buildInfo.codename,
    });
    this.state = "live";
    this.beat = setInterval(() => {
      void this.heartbeat().catch((e: unknown) => this.fail(e));
    }, this.deps.heartbeatMs);
    for (const m of this.early.splice(0)) await this.handle(m);
    await this.pump();
  }

  /** Coalesced: wakes during a pump just mark it dirty; one reader per socket. */
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.dirty = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.dirty = false;
        let more = true;
        while (more && this.state === "live") {
          const page = await this.deps.sync.changes(this.vc!, this.sent, WS_PAGE);
          if (page.entries.length > 0) {
            await this.send({ type: "changes", ...page });
            this.sent = page.entries[page.entries.length - 1]!.seq;
            await this.settingsChanged(page.entries);
          }
          more = page.hasMore;
        }
      } while (this.dirty && this.state === "live");
    } finally {
      this.pumping = false;
    }
  }

  private async settingsChanged(entries: JournalEntry[]): Promise<void> {
    if (!this.deps.settingsOf || !entries.some((e) => e.type === "vault_settings_changed")) return;
    await this.send({
      type: "vault_settings_changed",
      settings: await this.deps.settingsOf(this.vaultId),
    });
  }

  /** 03 §7: dead after two missed beats; revocation and blocking done elsewhere are noticed here. */
  private async heartbeat(): Promise<void> {
    if (Date.now() - this.lastHeard > 2 * this.deps.heartbeatMs) return this.close(CLOSE.silent);
    const row = await findDeviceById(this.deps.db, this.deviceId);
    if (!row || row.d.revokedAt) return this.close(CLOSE.forbidden, { type: "device_revoked" });
    if (row.status !== "active") return this.close(CLOSE.forbidden, err("user_blocked"));
    await this.touch();
    await this.send({ type: "ping" });
  }
}
