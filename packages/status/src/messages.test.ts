import { describe, expect, it } from "vitest";
import { STATUS_KEYS } from "./levels.js";
import {
  STATUS_MESSAGES,
  formatAge,
  formatLastConfirmed,
  formatStatusMessage,
} from "./messages.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const THEMED = /clone|jango|ordine 66|kaminoan|jedi/i;

describe("formatAge", () => {
  it.each([
    [30_000, "meno di 1 min", "under 1 min"],
    [2 * MIN + 59_000, "2 min", "2 min"],
    [3 * HOUR + 10 * MIN, "3 h", "3 h"],
    [2 * DAY + 5 * HOUR, "2 g", "2 d"],
  ])("%i ms", (ms, it_, en) => {
    expect(formatAge(ms, "it")).toBe(it_);
    expect(formatAge(ms, "en")).toBe(en);
  });
});

describe("formatStatusMessage", () => {
  it("pluralizes", () => {
    expect(formatStatusMessage({ key: "working.queued", params: { count: 1 } }, "it")).toBe(
      "1 modifica in attesa",
    );
    expect(formatStatusMessage({ key: "working.queued", params: { count: 3 } }, "en")).toBe(
      "3 changes waiting",
    );
  });

  it("interpolates age and count", () => {
    expect(
      formatStatusMessage(
        { key: "attention.offline", params: { ageMs: 2 * DAY, count: 14 } },
        "it",
      ),
    ).toBe("Server non raggiungibile da 2 g · 14 modifiche non salvate");
  });

  it("never says 0 unsaved changes", () => {
    expect(
      formatStatusMessage({ key: "attention.offline", params: { ageMs: 2 * DAY, count: 0 } }, "it"),
    ).toBe("Server non raggiungibile da 2 g");
    expect(formatStatusMessage({ key: "blocked.quota", params: { count: 0 } }, "en")).toBe(
      "Storage full",
    );
  });

  it("formats percent", () => {
    expect(formatStatusMessage({ key: "attention.quota", params: { percent: 95 } }, "it")).toBe(
      "Spazio quasi esaurito (95%)",
    );
  });
});

describe("formatLastConfirmed", () => {
  it("formats a past sync and the never case", () => {
    expect(formatLastConfirmed(1000 - 2 * MIN, 1000, "it")).toBe(
      "Ultimo sync confermato: 2 min fa",
    );
    expect(formatLastConfirmed(null, 1000, "en")).toBe("Never synced with the server");
  });
});

describe("STATUS_MESSAGES", () => {
  it("covers every key in both languages with the same shape", () => {
    for (const key of STATUS_KEYS) {
      const it_ = STATUS_MESSAGES.it[key];
      const en = STATUS_MESSAGES.en[key];
      expect(typeof it_).toBe(typeof en);
      if (typeof it_ === "object" && typeof en === "object") {
        expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort());
      }
    }
  });

  it("contains no themed lexicon", () => {
    const all = JSON.stringify(STATUS_MESSAGES);
    expect(all).not.toMatch(THEMED);
  });
});
