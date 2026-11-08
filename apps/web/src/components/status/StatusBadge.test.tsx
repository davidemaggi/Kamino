// @vitest-environment jsdom
import { DEFAULT_THRESHOLDS, describeStatus, exampleSnapshots } from "@kamino/status";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../../i18n/index.js";
import { StatusBadge } from "./StatusBadge.js";

const NOW = Date.UTC(2026, 10, 7, 12);
afterEach(cleanup);

function renderBadge(id: string, lang: "it" | "en" = "it") {
  const ex = exampleSnapshots(NOW).find((e) => e.id === id)!;
  const status = describeStatus(ex.snapshot, DEFAULT_THRESHOLDS, NOW);
  render(
    <I18nextProvider i18n={createI18n(lang)}>
      <StatusBadge status={status} now={NOW} />
    </I18nextProvider>,
  );
  return screen.getByRole("status");
}

describe("StatusBadge", () => {
  it.each([
    ["safe", "Tutto al sicuro", "safe"],
    ["queued", "3 modifiche in attesa", "working"],
    ["offline-2-days", "Server non raggiungibile da 2 g · 14 modifiche non salvate", "attention"],
    ["one-conflict", "1 conflitto da risolvere", "decision"],
    ["revoked", "Dispositivo revocato: il sync è fermo", "blocked"],
  ])("%s shows text and level", (id, text, level) => {
    const el = renderBadge(id);
    expect(el.textContent).toBe(text);
    expect(el.dataset["level"]).toBe(level);
    expect(el.querySelector("svg")).not.toBeNull();
  });

  it("describes the last confirmed sync for assistive tech", () => {
    const el = renderBadge("safe", "en");
    const id = el.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)?.textContent).toBe("Last confirmed sync: 2 min ago");
  });
});
