import type { App, EventRef, TAbstractFile } from "obsidian";

export interface WatchTarget {
  localChange(): void;
  localRename(from: string, to: string): void;
  syncNow(): Promise<void>;
  /** F4: the event only reflects what the engine itself just did. */
  isEcho?(path: string, stat: { size: number; mtime: number } | null): boolean;
}

/** 03 §8: the open file waits longer (typing), the others go quickly. */
export const ACTIVE_DELAY_MS = 5_000;
export const OTHER_DELAY_MS = 1_500;

/**
 * Vault events → a debounced cycle (E4). Renames are reported at once (the engine needs both
 * paths); coming back to the foreground (mobile resume) starts a cycle. Events missed here are
 * caught by the full scan of the next cycle.
 */
export class Watcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly app: App,
    private readonly target: () => WatchTarget | null,
    /** Debounce for the file open in the editor (S-02: `liveDebounceSec`). */
    private readonly activeDelayMs: () => number = () => ACTIVE_DELAY_MS,
  ) {}

  private async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    const s = await this.app.vault.adapter.stat(path).catch(() => null);
    return s ? { size: s.size, mtime: s.mtime } : null;
  }

  /** Schedules a cycle unless the engine itself caused the event (F4). */
  private async changed(path: string): Promise<void> {
    const t = this.target();
    if (t?.isEcho && t.isEcho(path, await this.stat(path))) return;
    this.schedule(path);
  }

  private schedule(path: string): void {
    if (this.stopped) return;
    const active = this.app.workspace.getActiveFile()?.path === path;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        if (!this.stopped) this.target()?.localChange();
      },
      active ? this.activeDelayMs() : OTHER_DELAY_MS,
    );
  }

  /** `register` = the plugin's registerEvent; returns the function that stops watching. */
  attach(register: (ref: EventRef) => void): () => void {
    const changed = (f: TAbstractFile) => void this.changed(f.path);
    register(this.app.vault.on("create", changed));
    register(this.app.vault.on("modify", changed));
    register(this.app.vault.on("delete", changed));
    register(
      this.app.vault.on("rename", (f: TAbstractFile, oldPath: string) => {
        if (this.stopped) return;
        void (async () => {
          const t = this.target();
          // A rename the engine made (following a remote move) is not the user's.
          if (t?.isEcho && t.isEcho(oldPath, null) && t.isEcho(f.path, await this.stat(f.path)))
            return;
          t?.localRename(oldPath, f.path);
          this.schedule(f.path);
        })();
      }),
    );
    const resume = () => {
      if (!this.stopped && document.visibilityState === "visible") void this.target()?.syncNow();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => {
      this.stopped = true;
      if (this.timer !== null) clearTimeout(this.timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
    };
  }
}
