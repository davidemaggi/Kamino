import { describe, expect, it, vi } from "vitest";
import { DiagnosticLog } from "./log.js";

const T0 = Date.UTC(2026, 10, 13, 10, 0, 0);

function make(over: { max?: number } = {}) {
  let now = T0;
  const saved: string[] = [];
  let timer: (() => void) | null = null;
  const log = new DiagnosticLog({
    now: () => now,
    save: (text) => {
      saved.push(text);
      return Promise.resolve();
    },
    schedule: (fn) => {
      timer = fn;
      return () => (timer = null);
    },
    ...over,
  });
  return {
    log,
    saved,
    tick: (ms: number) => (now += ms),
    fire: () => {
      const t = timer;
      timer = null;
      t?.();
    },
    pending: () => timer !== null,
  };
}

describe("DiagnosticLog", () => {
  it("records codes with an ISO timestamp", () => {
    const { log } = make();
    log.add("plugin_start");
    expect(log.lines()).toEqual(["2026-11-13T10:00:00.000Z plugin_start"]);
  });

  it("never records anything that is not a code: other characters become '?'", () => {
    const { log } = make();
    log.add("upload_failed_Notes/Secret plan.md");
    expect(log.lines()[0]).toBe("2026-11-13T10:00:00.000Z upload_failed_Notes?Secret?plan.md");
    log.add("x".repeat(200));
    expect(log.lines()[1]!.split(" ")[1]!.length).toBe(64);
  });

  it("collapses a repeated code into a counter", () => {
    const { log, tick } = make();
    log.add("persist_failed");
    tick(1000);
    log.add("persist_failed");
    log.add("persist_failed");
    expect(log.lines()).toEqual(["2026-11-13T10:00:01.000Z persist_failed (x3)"]);
  });

  it("keeps only the newest lines", () => {
    const { log } = make({ max: 3 });
    for (const c of ["a", "b", "c", "d"]) log.add(c);
    expect(log.lines().map((l) => l.split(" ")[1])).toEqual(["b", "c", "d"]);
  });

  it("saves once per scheduled flush, and flush() saves at once", async () => {
    const { log, saved, fire, pending } = make();
    log.add("a");
    log.add("b");
    expect(pending()).toBe(true);
    fire();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain(" a\n");
    log.add("c");
    await log.flush();
    expect(saved).toHaveLength(2);
    expect(pending()).toBe(false);
    await log.flush();
    expect(saved).toHaveLength(2);
  });

  it("restores saved lines and ignores malformed ones", () => {
    const { log } = make();
    log.restore(
      "2026-11-12T09:00:00.000Z old_code\nnot a line\n\n2026-11-12T09:00:01.000Z x (x2)\n",
    );
    log.add("new_code");
    expect(log.lines()).toEqual([
      "2026-11-12T09:00:00.000Z old_code",
      "2026-11-12T09:00:01.000Z x (x2)",
      "2026-11-13T10:00:00.000Z new_code",
    ]);
  });

  it("a failing save is swallowed", async () => {
    const log = new DiagnosticLog({
      now: () => T0,
      save: vi.fn(() => Promise.reject(new Error("disk"))),
      schedule: () => () => {},
    });
    log.add("a");
    await expect(log.flush()).resolves.toBeUndefined();
  });

  it("report: header fields, then the lines", () => {
    const { log } = make();
    log.add("plugin_start");
    const r = log.report({ version: "1.0.0-rc.1", mobile: false });
    expect(r).toBe(
      [
        "version: 1.0.0-rc.1",
        "mobile: false",
        "generated: 2026-11-13T10:00:00.000Z",
        "",
        "2026-11-13T10:00:00.000Z plugin_start",
      ].join("\n"),
    );
  });
});
