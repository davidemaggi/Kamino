// R-4: WebSocket behaviour on mobile across background/resume and network
// switches. Every open/close/error/visibility change/gap/catch-up is appended
// to the result note with a timestamp, so the log survives an app kill.
import { Notice, type App } from "obsidian";
import { errorText, nowIso, Report } from "./report.ts";

interface ServerMsg {
  type: string;
  seq?: number;
  from?: number;
  to?: number;
  truncated?: boolean;
  events?: { seq: number }[];
}

const STALE_MS = 5_000; // the server sends an event every second
const MAX_BACKOFF_MS = 30_000;

export class WsSpike {
  #ws: WebSocket | null = null;
  #report: Report | null = null;
  #lastSeq: number | null = null;
  #lastMessageAt = 0;
  #disconnectedAt: number | null = null;
  #openedAt = 0;
  #backoff = 1_000;
  #retry: number | null = null;
  #watchdog: number | null = null;
  #running = false;
  /** False from OPEN until the first catch-up of the current socket: live events are ignored meanwhile. */
  #synced = false;
  #stats = {
    opens: 0,
    closes: 0,
    errors: 0,
    gaps: 0,
    missedLive: 0,
    caughtUp: 0,
    stale: 0,
    preSyncIgnored: 0,
  };

  constructor(
    private readonly app: App,
    private readonly serverUrl: () => string,
    private readonly device: () => string,
  ) {}

  get running(): boolean {
    return this.#running;
  }

  async start(): Promise<void> {
    if (this.#running) {
      new Notice("R-4 already running");
      return;
    }
    this.#report = await Report.create(
      this.app,
      "R-4",
      this.device(),
      "WebSocket background/resume/network switch",
    );
    this.#running = true;
    document.addEventListener("visibilitychange", this.#onVisibility);
    window.addEventListener("online", this.#onOnline);
    window.addEventListener("offline", this.#onOffline);
    this.#watchdog = window.setInterval(this.#checkStale, 1_000);
    await this.#log(`start, url ${this.#wsUrl()}`);
    this.#connect("start");
    new Notice("R-4 started: now background the app, switch Wi-Fi/cellular, come back.", 8000);
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    document.removeEventListener("visibilitychange", this.#onVisibility);
    window.removeEventListener("online", this.#onOnline);
    window.removeEventListener("offline", this.#onOffline);
    if (this.#watchdog !== null) window.clearInterval(this.#watchdog);
    if (this.#retry !== null) window.clearTimeout(this.#retry);
    this.#ws?.close(1000, "stop");
    this.#ws = null;
    await this.#log(`stop. stats ${JSON.stringify(this.#stats)}, lastSeq ${this.#lastSeq}`);
    await this.#report?.done();
    this.#report = null;
  }

  #wsUrl(): string {
    return `${this.serverUrl().replace(/^http/, "ws")}/ws`;
  }

  async #log(text: string): Promise<void> {
    await this.#report?.line(`- ${nowIso()} ${text}`);
  }

  #connect(reason: string): void {
    if (!this.#running) return;
    if (
      this.#ws &&
      (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)
    )
      return;
    if (this.#retry !== null) {
      window.clearTimeout(this.#retry);
      this.#retry = null;
    }
    const attemptAt = performance.now();
    void this.#log(`connecting (${reason})`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.#wsUrl());
    } catch (err) {
      void this.#log(`constructor threw ${errorText(err)}`);
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      if (this.#ws !== ws) return;
      this.#stats.opens++;
      this.#synced = false;
      this.#openedAt = performance.now();
      this.#lastMessageAt = Date.now();
      this.#backoff = 1_000;
      const offline =
        this.#disconnectedAt === null ? "n/a" : `${Date.now() - this.#disconnectedAt} ms`;
      void this.#log(
        `OPEN after ${Math.round(this.#openedAt - attemptAt)} ms handshake; disconnected for ${offline}; hello lastSeq=${this.#lastSeq}`,
      );
      this.#disconnectedAt = null;
      ws.send(JSON.stringify({ type: "hello", lastSeq: this.#lastSeq }));
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.#ws === ws) this.#onMessage(String(ev.data)); // ignore superseded sockets
    };
    ws.onerror = () => {
      this.#stats.errors++;
      void this.#log(`ERROR event (readyState ${ws.readyState}, online=${navigator.onLine})`);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.#ws !== ws) return;
      this.#stats.closes++;
      this.#ws = null;
      this.#disconnectedAt ??= Date.now();
      void this.#log(
        `CLOSE code=${ev.code} reason="${ev.reason}" clean=${ev.wasClean} visibility=${document.visibilityState} online=${navigator.onLine}`,
      );
      this.#scheduleReconnect();
    };
  }

  #onMessage(raw: string): void {
    this.#lastMessageAt = Date.now();
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      return;
    }
    if (msg.type === "catchup") {
      const events = msg.events ?? [];
      const expectedFrom = this.#lastSeq;
      const contiguous = events.every((e, i) => i === 0 || e.seq === (events[i - 1]?.seq ?? 0) + 1);
      const startsRight =
        expectedFrom === null || events.length === 0 || events[0]?.seq === expectedFrom + 1;
      const last = events[events.length - 1];
      if (last) this.#lastSeq = last.seq;
      else this.#lastSeq ??= msg.to ?? 0;
      this.#stats.caughtUp += events.length;
      this.#synced = true;
      void this.#log(
        `CATCH-UP ${events.length} events (${msg.from}→${msg.to}) in ${Math.round(performance.now() - this.#openedAt)} ms since open; contiguous=${contiguous && startsRight}, truncated=${msg.truncated}`,
      );
    } else if (msg.type === "event" && msg.seq !== undefined) {
      if (!this.#synced) {
        // Covered by the pending catch-up (its "to" is >= this seq): never count it as a gap.
        this.#stats.preSyncIgnored++;
        return;
      }
      if (this.#lastSeq !== null && msg.seq <= this.#lastSeq) return; // already got it via catch-up
      if (this.#lastSeq !== null && msg.seq !== this.#lastSeq + 1) {
        this.#stats.gaps++;
        this.#stats.missedLive += msg.seq - this.#lastSeq - 1;
        void this.#log(`GAP in live stream: expected ${this.#lastSeq + 1}, got ${msg.seq}`);
      }
      this.#lastSeq = msg.seq;
    }
  }

  #scheduleReconnect(): void {
    if (!this.#running || this.#retry !== null) return;
    const delay = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS);
    this.#retry = window.setTimeout(() => {
      this.#retry = null;
      this.#connect(`retry after ${delay} ms`);
    }, delay);
  }

  /** Detects half-open sockets (no traffic although "open"), typical after resume. */
  readonly #checkStale = () => {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const silent = Date.now() - this.#lastMessageAt;
    if (silent > STALE_MS) {
      this.#stats.stale++;
      this.#disconnectedAt = this.#lastMessageAt;
      void this.#log(`STALE: no message for ${silent} ms while readyState OPEN; forcing reconnect`);
      this.#ws = null;
      ws.close(4000, "stale");
      this.#connect("stale");
    }
  };

  readonly #onVisibility = () => {
    void this.#log(
      `visibility → ${document.visibilityState} (ws readyState ${this.#ws?.readyState ?? "none"})`,
    );
    if (document.visibilityState === "visible") this.#connect("resume");
  };

  readonly #onOnline = () => {
    void this.#log("window online");
    this.#connect("online");
  };

  readonly #onOffline = () => void this.#log("window offline");
}
