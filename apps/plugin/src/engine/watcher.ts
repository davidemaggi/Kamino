import type { App, EventRef, TAbstractFile } from "obsidian";

export interface WatchTarget {
  localChange(): void;
  localRename(from: string, to: string): void;
  syncNow(): Promise<void>;
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
  ) {}

  private schedule(path: string): void {
    if (this.stopped) return;
    const active = this.app.workspace.getActiveFile()?.path === path;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        if (!this.stopped) this.target()?.localChange();
      },
      active ? ACTIVE_DELAY_MS : OTHER_DELAY_MS,
    );
  }

  /** `register` = the plugin's registerEvent; returns the function that stops watching. */
  attach(register: (ref: EventRef) => void): () => void {
    const changed = (f: TAbstractFile) => this.schedule(f.path);
    register(this.app.vault.on("create", changed));
    register(this.app.vault.on("modify", changed));
    register(this.app.vault.on("delete", changed));
    register(
      this.app.vault.on("rename", (f: TAbstractFile, oldPath: string) => {
        if (this.stopped) return;
        this.target()?.localRename(oldPath, f.path);
        this.schedule(f.path);
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
