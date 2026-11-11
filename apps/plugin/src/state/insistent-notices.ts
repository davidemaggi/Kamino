import { DEFAULT_THRESHOLDS, describeStatus, formatStatusMessage, severity } from "@kamino/status";
import type { Lang } from "../i18n/index.js";
import type { SyncStateSource } from "./types.js";

/** S-05: the warning comes back every hour while the problem lasts. */
export const REPEAT_MS = 3_600_000;
const CHECK_MS = 60_000;

/**
 * Never silent (S-05): from Attention up (stale queue, server unreachable, decisions, blocked),
 * a notice now and then every hour until the state improves. Files waiting for Wi-Fi alone
 * don't count: that is the user's choice (spec §6.3).
 */
export class InsistentNotices {
  private lastShown: number | null = null;
  private lastKey: string | null = null;

  constructor(
    private readonly o: {
      source: Pick<SyncStateSource, "snapshot" | "deferred" | "pending" | "onChange">;
      clock: () => number;
      notice(message: string): void;
      lang: Lang;
    },
  ) {}

  start(): () => void {
    const off = this.o.source.onChange(() => this.check());
    const timer = setInterval(() => this.check(), CHECK_MS);
    this.check();
    return () => {
      off();
      clearInterval(timer);
    };
  }

  private check(): void {
    const now = this.o.clock();
    const s = this.o.source.snapshot();
    const d = describeStatus(s, DEFAULT_THRESHOLDS, now);
    const onlyWifi =
      s.blocked === null &&
      s.conflicts === 0 &&
      s.unreachableSince === null &&
      this.o.source.pending().length === 0 &&
      this.o.source.deferred().length > 0 &&
      this.o.source.deferred().every((f) => f.reason === "network");
    if (severity(d.level) < severity("attention") || onlyWifi) {
      this.lastShown = null;
      this.lastKey = null;
      return;
    }
    const key = d.message.key;
    if (this.lastShown !== null && this.lastKey === key && now - this.lastShown < REPEAT_MS) return;
    this.lastShown = now;
    this.lastKey = key;
    this.o.notice(formatStatusMessage(d.message, this.o.lang));
  }
}
