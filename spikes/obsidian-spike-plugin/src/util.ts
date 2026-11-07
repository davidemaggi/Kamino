import { FuzzySuggestModal, Notice, type App } from "obsidian";

export const MiB = 1024 * 1024;

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function ms(start: number): number {
  return Math.round(performance.now() - start);
}

export function rate(bytes: number, millis: number): string {
  return millis > 0 ? `${(bytes / MiB / (millis / 1000)).toFixed(1)} MB/s` : "n/a";
}

/** Lets the UI breathe during long loops (and keeps mobile watchdogs quiet). */
export function yieldToUi(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

interface PerfMemory {
  usedJSHeapSize: number;
}

/** Tracks the peak JS heap (Chromium only); reports "n/a" elsewhere (iOS). */
export class HeapPeak {
  #peak = 0;

  sample(): void {
    const mem = (performance as unknown as { memory?: PerfMemory }).memory;
    if (mem && mem.usedJSHeapSize > this.#peak) this.#peak = mem.usedJSHeapSize;
  }

  toString(): string {
    return this.#peak > 0 ? `${(this.#peak / MiB).toFixed(0)} MB` : "n/a";
  }
}

/** A long-lived Notice whose text can be updated (progress). */
export class Progress {
  readonly #notice = new Notice("", 0);

  set(text: string): void {
    this.#notice.setMessage(text);
  }

  close(): void {
    this.#notice.hide();
  }
}

class PickModal<T> extends FuzzySuggestModal<T> {
  constructor(
    app: App,
    private readonly items: T[],
    private readonly label: (item: T) => string,
    private readonly onPick: (item: T) => void,
  ) {
    super(app);
  }

  getItems(): T[] {
    return this.items;
  }

  getItemText(item: T): string {
    return this.label(item);
  }

  onChooseItem(item: T): void {
    this.onPick(item);
  }
}

export function pick<T>(
  app: App,
  items: T[],
  label: (item: T) => string,
  placeholder: string,
): Promise<T | null> {
  return new Promise((resolve) => {
    let chosen = false;
    const modal = new PickModal(app, items, label, (item) => {
      chosen = true;
      resolve(item);
    });
    modal.setPlaceholder(placeholder);
    modal.onClose = () => {
      // onChooseItem fires after onClose in some versions: defer the "cancelled" answer.
      setTimeout(() => {
        if (!chosen) resolve(null);
      }, 50);
    };
    modal.open();
  });
}
