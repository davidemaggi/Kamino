import type { Backlog, StopReason } from "@kamino/sync-engine";
import type { InitialTransfer, TransferProgress } from "./types.js";

/** What the initial transfer needs from the engine. */
export interface TransferEngine {
  backlog(): Backlog;
  pause(): void;
  resume(): void;
  syncNow(): Promise<void>;
  readonly paused: boolean;
  readonly stopped: StopReason | null;
  snapshot(): { unreachableSince: number | null; syncing: boolean };
  onChange(cb: () => void): () => void;
}

/** `InitialTransfer` from the engine's first cycle (E7): files and bytes, pause and resume. */
export class RealTransfer implements InitialTransfer {
  private direction: "upload" | "download" | null = null;
  private files = 0;
  private bytes = 0;
  private cycled = false;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly engine: () => TransferEngine | null) {}

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }

  private run(): void {
    const e = this.engine();
    if (!e) return;
    this.unsubscribe?.();
    this.unsubscribe = e.onChange(() => this.emit());
    this.cycled = false;
    void e.syncNow().then(() => {
      this.cycled = true;
      this.emit();
    });
  }

  start(direction: "upload" | "download"): void {
    this.direction = direction;
    this.files = 0;
    this.bytes = 0;
    this.engine()?.resume();
    this.run();
    this.emit();
  }

  progress(): TransferProgress | null {
    const e = this.engine();
    if (!this.direction || !e) return null;
    const left = e.backlog()[this.direction === "upload" ? "up" : "down"];
    // Totals grow as the cycle discovers work (the snapshot arrives after the start).
    this.files = Math.max(this.files, left.files);
    this.bytes = Math.max(this.bytes, left.bytes);
    const snap = e.snapshot();
    let phase: TransferProgress["phase"] = "running";
    if (e.stopped) phase = "failed";
    else if (e.paused) phase = "paused";
    else if (snap.unreachableSince !== null) phase = "interrupted";
    else if (this.cycled && left.files === 0) phase = "done";
    return {
      direction: this.direction,
      phase,
      files: { done: this.files - left.files, total: this.files },
      bytes: { done: this.bytes - left.bytes, total: this.bytes },
    };
  }

  pause(): void {
    this.engine()?.pause();
    this.emit();
  }

  resume(): void {
    this.engine()?.resume();
    this.emit();
  }

  retry(): void {
    this.run();
    this.emit();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
