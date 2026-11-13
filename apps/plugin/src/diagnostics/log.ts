// Diagnostic log for support (rc1): engine codes, plugin start and status changes, with a
// timestamp. Codes only, never paths, file names, contents, links or tokens: anything outside
// [A-Za-z0-9_.:-] becomes "?". Kept in memory, capped, and saved in the plugin folder.

export interface DiagnosticLogDeps {
  now: () => number;
  /** Persists the whole log (the plugin writes it atomically in its folder). */
  save: (text: string) => Promise<void>;
  /** Runs `fn` later (debounced save); returns a cancel function. */
  schedule: (fn: () => void) => () => void;
  max?: number;
}

const CODE_MAX = 64;
const LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) ([A-Za-z0-9_.:?-]{1,64})(?: \(x(\d+)\))?$/;

interface Entry {
  at: string;
  code: string;
  count: number;
}

export class DiagnosticLog {
  private entries: Entry[] = [];
  private cancel: (() => void) | null = null;
  private dirty = false;
  private readonly max: number;

  constructor(private readonly d: DiagnosticLogDeps) {
    this.max = d.max ?? 1000;
  }

  add(code: string): void {
    const clean = code.replace(/[^A-Za-z0-9_.:-]/g, "?").slice(0, CODE_MAX) || "?";
    const at = new Date(this.d.now()).toISOString();
    const last = this.entries.at(-1);
    if (last?.code === clean) {
      last.count++;
      last.at = at;
    } else {
      this.entries.push({ at, code: clean, count: 1 });
      if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    }
    this.dirty = true;
    this.cancel ??= this.d.schedule(() => {
      this.cancel = null;
      void this.flush();
    });
  }

  /** Lines saved by an earlier session go before the new ones. */
  restore(text: string): void {
    const old: Entry[] = [];
    for (const l of text.split("\n")) {
      const m = LINE.exec(l.trim());
      if (m) old.push({ at: m[1]!, code: m[2]!, count: Number(m[3] ?? 1) });
    }
    this.entries = [...old, ...this.entries].slice(-this.max);
  }

  lines(): string[] {
    return this.entries.map((e) => `${e.at} ${e.code}${e.count > 1 ? ` (x${e.count})` : ""}`);
  }

  async flush(): Promise<void> {
    this.cancel?.();
    this.cancel = null;
    if (!this.dirty) return;
    this.dirty = false;
    await this.d.save(`${this.lines().join("\n")}\n`).catch(() => {});
  }

  /** Text to paste in a support request: `key: value` header, a blank line, the log. */
  report(header: Record<string, string | number | boolean>): string {
    const head = Object.entries(header).map(([k, v]) => `${k}: ${String(v)}`);
    head.push(`generated: ${new Date(this.d.now()).toISOString()}`);
    return [...head, "", ...this.lines()].join("\n");
  }
}
