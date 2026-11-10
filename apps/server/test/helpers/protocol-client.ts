import { ServerMessage, Snapshot, type JournalEntry } from "@kamino/protocol";
import type { WebSocket } from "ws";
import type { TestApp } from "./app.js";
import type { TestDevice } from "./sync.js";
import { hello } from "./ws.js";

export interface FileState {
  path: string;
  versionId: string;
  contentHash: string;
}

/**
 * A device that knows the vault only from what the server sends it (WebSocket pushes, `changes`,
 * snapshots). It records every protocol violation it sees instead of throwing.
 */
export class ProtocolClient {
  readonly state = new Map<string, FileState>();
  cursor = 0;
  readonly violations: string[] = [];
  /** Server answers with status >= 500. */
  readonly serverErrors: string[] = [];
  /** What actually happened, so the test can prove it exercised each path. */
  readonly stats = { pushes: 0, pulls: 0, snapshots: 0 };
  private ws: WebSocket | undefined;
  private busy: Promise<void> = Promise.resolve();

  constructor(
    readonly t: TestApp,
    readonly device: TestDevice,
    readonly name: string,
  ) {}

  get connected(): boolean {
    return this.ws !== undefined;
  }

  private apply(entries: JournalEntry[]): void {
    for (const e of entries) {
      if (e.seq !== this.cursor + 1)
        this.violations.push(`${this.name}: expected seq ${this.cursor + 1}, got ${e.seq}`);
      if (e.seq <= this.cursor) continue; // a duplicate: never apply twice
      this.cursor = e.seq;
      if (e.ignorable || e.kind === "folder") continue;
      const known = this.state.get(e.fileId);
      switch (e.type) {
        case "file_put":
        case "file_restored":
          if (e.versionId && e.contentHash)
            this.state.set(e.fileId, {
              path: e.path,
              versionId: e.versionId,
              contentHash: e.contentHash,
            });
          break;
        case "file_moved":
          if (known) this.state.set(e.fileId, { ...known, path: e.path });
          break;
        case "file_deleted":
          this.state.delete(e.fileId);
          break;
      }
    }
  }

  private async snapshot(): Promise<void> {
    const r = await this.device.call("GET", `/vaults/${this.device.vaultId}/snapshot`);
    this.check(r.statusCode, "snapshot");
    const s = Snapshot.parse(r.json());
    this.stats.snapshots++;
    this.state.clear();
    for (const f of s.files)
      if (f.kind === "file" && f.versionId && f.contentHash)
        this.state.set(f.fileId, {
          path: f.path,
          versionId: f.versionId,
          contentHash: f.contentHash,
        });
    this.cursor = s.head;
  }

  check(status: number, what: string): void {
    if (status >= 500) this.serverErrors.push(`${this.name}: ${what} → ${status}`);
  }

  /** Opens a socket from the current cursor; `cursor_too_old` → snapshot, then reconnect. */
  async connect(): Promise<void> {
    if (this.ws) return;
    await this.t.app.ready();
    const ws = await this.t.app.injectWS("/api/v1/ws");
    this.ws = ws;
    let tooOld = false;
    ws.on("message", (data) => {
      const m = ServerMessage.parse(JSON.parse(String(data)));
      // Messages are handled in order, one at a time.
      this.busy = this.busy.then(async () => {
        if (m.type === "changes") {
          this.stats.pushes++;
          this.apply(m.entries);
          ws.send(JSON.stringify({ type: "ack", seq: this.cursor }));
        } else if (m.type === "error" && m.code === "cursor_too_old") tooOld = true;
        else if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      });
    });
    const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
    void closed.then(async () => {
      await this.busy;
      if (this.ws === ws) this.ws = undefined;
      if (tooOld) {
        await this.snapshot();
        await this.connect();
      }
    });
    ws.send(JSON.stringify(hello(this.device.token, this.cursor)));
  }

  /** The network drops: no goodbye. */
  drop(): void {
    this.ws?.terminate();
    this.ws = undefined;
  }

  /** Periodic/manual mode: pull with REST while disconnected. */
  async pull(): Promise<void> {
    if (this.ws) return;
    for (;;) {
      const r = await this.device.call(
        "GET",
        `/vaults/${this.device.vaultId}/changes?after=${this.cursor}&limit=7`,
      );
      if (r.statusCode === 410) {
        await this.snapshot();
        continue;
      }
      this.check(r.statusCode, "changes");
      const page = r.json() as { entries: JournalEntry[]; hasMore: boolean };
      this.stats.pulls++;
      this.apply(page.entries);
      await this.device.call("POST", `/vaults/${this.device.vaultId}/ack`, { seq: this.cursor });
      if (!page.hasMore) return;
    }
  }

  /** Waits until pending messages are handled. */
  async settle(): Promise<void> {
    await this.busy;
  }
}
