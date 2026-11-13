import { ServerMessage, type Hello } from "@kamino/protocol";
import { retryDelay } from "@kamino/sync-core";
import type { Clock } from "./ports.js";

export interface SocketConn {
  send(data: string): void;
  close(code?: number): void;
}
export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number): void;
}
/** Opens /api/v1/ws; a failure to connect is reported as onClose(1006). */
export type SocketFactory = (h: SocketHandlers) => SocketConn;

export type RealtimeEvent =
  | { type: "connected"; head: number }
  | { type: "disconnected" }
  | { type: "changes"; head: number }
  | { type: "settings" }
  | { type: "revoked" }
  | { type: "blocked" }
  | { type: "protocol" }
  | { type: "resync" }
  /** 4404: the vault or the device may be gone; the engine verifies via REST. */
  | { type: "check" }
  /** 03 §10: pairing news for this vault, handed to the host as is. */
  | { type: "pairing"; message: PairingMessage };

export type PairingMessage = Extract<
  ServerMessage,
  { type: "pairing_request" | "pairing_closed" | "pairing_reused" }
>;

/** Server close codes (M2a, apps/server/src/realtime). */
const CLOSE = {
  unauthorized: 4401,
  forbidden: 4403,
  notFound: 4404,
  replaced: 4409,
  cursorTooOld: 4410,
  protocol: 4426,
} as const;
/** The server pings every 30 s: this long without any message means the link is dead. */
export const SILENCE_MS = 75_000;
const WATCH_EVERY_MS = 15_000;
/** Another connection of this device took the slot: give it room (spec §6.2). */
const REPLACED_WAIT_MS = 300_000;
/** I3: a connection that lived this long resets the reconnection backoff. */
const STABLE_MS = 60_000;

/**
 * The realtime doorbell (spec F1/F2): it only says that something changed; the engine fetches
 * the data over REST. Reconnects with backoff, stops for good on revocation, blocking and
 * protocol errors.
 */
export class Realtime {
  private conn: SocketConn | null = null;
  /** Each connection and timer belongs to one generation: stale ones do nothing. */
  private gen = 0;
  private attempt = 0;
  private stopped = true;
  private terminal = false;
  private live = false;
  private lastMessage = 0;
  /** When the current connection got its welcome (null = not yet). */
  private welcomedAt: number | null = null;

  constructor(
    private readonly o: {
      socket: SocketFactory;
      clock: Clock;
      hello: () => Hello;
      onEvent(e: RealtimeEvent): void;
      log?(code: string): void;
    },
  ) {}

  get connected(): boolean {
    return this.live;
  }

  start(): void {
    if (!this.stopped || this.terminal) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    this.live = false;
    this.conn?.close(1000);
    this.conn = null;
  }

  private connect(): void {
    if (this.stopped || this.terminal) return;
    const gen = ++this.gen;
    this.lastMessage = this.o.clock.now();
    this.conn = this.o.socket({
      onOpen: () => {
        if (gen === this.gen) this.send(this.o.hello());
      },
      onMessage: (data) => {
        if (gen === this.gen) this.message(data);
      },
      onClose: (code) => {
        if (gen === this.gen) this.closed(code);
      },
    });
    void this.watch(gen);
  }

  private send(msg: unknown): void {
    this.conn?.send(JSON.stringify(msg));
  }

  private message(data: string): void {
    this.lastMessage = this.o.clock.now();
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      this.o.log?.("ws_bad_message");
      return;
    }
    const m = ServerMessage.safeParse(raw);
    if (!m.success) {
      this.o.log?.("ws_unknown_message");
      return;
    }
    const msg = m.data;
    switch (msg.type) {
      case "welcome":
        // I3: the backoff resets only once the connection has proved stable (see closed()).
        this.live = true;
        this.welcomedAt = this.o.clock.now();
        this.o.onEvent({ type: "connected", head: msg.head });
        return;
      case "changes":
        this.o.onEvent({ type: "changes", head: msg.head });
        return;
      case "ping":
        this.send({ type: "pong" });
        return;
      case "vault_settings_changed":
        this.o.onEvent({ type: "settings" });
        return;
      case "device_revoked":
        this.end({ type: "revoked" });
        return;
      case "pairing_request":
      case "pairing_closed":
      case "pairing_reused":
        this.o.onEvent({ type: "pairing", message: msg });
        return;
      case "error":
        this.o.log?.(`ws_error_${msg.code}`);
        return;
      case "pong":
        return;
    }
  }

  /** Stops for good: the engine is told once. */
  private end(e: RealtimeEvent): void {
    if (this.terminal) return;
    this.terminal = true;
    this.gen++;
    this.live = false;
    this.conn?.close(1000);
    this.conn = null;
    this.o.onEvent(e);
  }

  private closed(code: number): void {
    this.gen++; // later callbacks of this connection are ignored
    this.conn = null;
    const wasLive = this.live;
    this.live = false;
    if (this.stopped) return;
    // I3: a connection that lasted is a fresh start; one closed right after welcome is not.
    if (this.welcomedAt !== null && this.o.clock.now() - this.welcomedAt >= STABLE_MS)
      this.attempt = 0;
    this.welcomedAt = null;
    switch (code) {
      case CLOSE.protocol:
        this.end({ type: "protocol" });
        return;
    }
    if (wasLive) this.o.log?.("ws_lost");
    this.o.onEvent({ type: "disconnected" });
    if (code === CLOSE.cursorTooOld) this.o.onEvent({ type: "resync" });
    // I1: 4401/4403 also follow a slow hello: the engine verifies via REST before stopping.
    if (code === CLOSE.notFound || code === CLOSE.unauthorized || code === CLOSE.forbidden)
      this.o.onEvent({ type: "check" });
    const delay =
      code === CLOSE.replaced
        ? REPLACED_WAIT_MS - 30_000 + this.o.clock.random() * 60_000
        : retryDelay(this.attempt++, this.o.clock.random());
    void this.reconnectAfter(delay, this.gen);
  }

  private async reconnectAfter(ms: number, gen: number): Promise<void> {
    await this.o.clock.sleep(ms);
    if (gen !== this.gen || this.stopped || this.terminal) return;
    this.connect();
  }

  /** No message for SILENCE_MS (not even the server's ping): the link is dead. */
  private async watch(gen: number): Promise<void> {
    for (;;) {
      await this.o.clock.sleep(WATCH_EVERY_MS);
      if (gen !== this.gen || this.stopped) return;
      if (this.o.clock.now() - this.lastMessage >= SILENCE_MS) {
        this.o.log?.("ws_silent");
        this.conn?.close(4000);
        this.closed(1006);
        return;
      }
    }
  }
}
