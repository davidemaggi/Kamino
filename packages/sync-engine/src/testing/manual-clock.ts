import type { Clock } from "../ports.js";

/** Time moves only through advance(); sleeps end when their time comes. */
export class ManualClock implements Clock {
  t = 0;
  private sleepers: { at: number; r: () => void }[] = [];
  now() {
    return this.t;
  }
  sleep(ms: number) {
    return new Promise<void>((r) => this.sleepers.push({ at: this.t + ms, r }));
  }
  random() {
    return 0.5;
  }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.sleepers.filter((s) => s.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.t = Math.max(this.t, next.at);
      this.sleepers = this.sleepers.filter((s) => s !== next);
      next.r();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    this.t = end;
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
}
