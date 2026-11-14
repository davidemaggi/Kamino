// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../i18n/index.js";
import { AboutPage } from "./AboutPage.js";

const info = {
  version: "0.1.0",
  codename: "Ash",
  protocol: { min: 1, max: 1 },
  commit: "abc1234",
  buildDate: "2026-11-06T00:00:00.000Z",
};

function renderAbout(lang: "it" | "en") {
  const i18n = createI18n(lang);
  return render(
    <I18nextProvider i18n={i18n}>
      <AboutPage />
    </I18nextProvider>,
  );
}

describe("AboutPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(info), { status: 200 }))),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows version and codename from /version (en)", async () => {
    renderAbout("en");
    expect(await screen.findByText("0.1.0")).toBeTruthy();
    expect(screen.getByText("Ash")).toBeTruthy();
    expect(screen.getByText("Version")).toBeTruthy();
  });

  it("uses the Italian label in it", async () => {
    renderAbout("it");
    expect(await screen.findByText("0.1.0")).toBeTruthy();
    expect(screen.getByText("Versione")).toBeTruthy();
  });

  it("formats the protocol, shortens the commit hash and copies the details", async () => {
    const full = { ...info, protocol: { min: 1, max: 2 }, commit: "abc1234def5678901234" };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(full), { status: 200 }))),
    );
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderAbout("en");
    expect(await screen.findByText("v1 to v2")).toBeTruthy();
    expect(screen.getByText("abc1234")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("commit abc1234def5678901234"));
  });

  it("shows an error message when /version fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("nope", { status: 500 }))),
    );
    renderAbout("en");
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
