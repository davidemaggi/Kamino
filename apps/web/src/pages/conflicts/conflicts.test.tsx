// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const diffCalls: Array<{ layout: string; editable: boolean }> = [];
vi.mock("@kamino/ui-diff", () => ({
  diffSummary: () => ({ changes: 2 }),
  createDiffView: (parent: HTMLElement, o: { layout: string; editable: boolean }) => {
    diffCalls.push({ layout: o.layout, editable: o.editable });
    const el = parent.ownerDocument.createElement("div");
    el.className = "fake-diff";
    parent.append(el);
    return { getMerged: () => "merged text", destroy: () => el.remove() };
  },
}));

import { http, HttpResponse } from "msw";
import { features } from "../../lib/features.js";
import { signInAs } from "../../mocks/db.js";
import { server } from "../../test/setup.js";
import { simulateStaleNext, ud } from "../../mocks/userdata.js";
import { renderRoute } from "../../test/render.js";

afterEach(() => {
  cleanup();
  diffCalls.length = 0;
  vi.unstubAllGlobals();
  features.historyWrites = true;
});

const list = () => screen.getByRole("navigation", { name: "Conflitti" });

describe("ConflictCenter (desktop)", () => {
  it("groups by vault and shows the first conflict", async () => {
    signInAs("demo");
    await renderRoute("/conflicts");
    await screen.findByText("Foto/vacanza.svg");
    expect(within(list()).getByText("Note")).toBeDefined();
    expect(within(list()).getByText("Lavoro")).toBeDefined();
    expect(await screen.findByRole("heading", { name: "Spesa.md" })).toBeDefined();
    expect(diffCalls.at(-1)).toEqual({ layout: "split", editable: false });
  });

  it("keep mine: request, toast, next conflict", async () => {
    signInAs("demo");
    const { router } = await renderRoute("/conflicts/c-shopping");
    fireEvent.click(await screen.findByRole("button", { name: "Tieni la mia" }));
    expect(
      await screen.findByText("Hai tenuto la tua versione. Quella di iPhone resta nello storico."),
    ).toBeDefined();
    await waitFor(() => expect(router.state.location.pathname).toBe("/conflicts/c-plan"));
    expect(ud.conflicts.some((c) => c.id === "c-shopping")).toBe(false);
  });

  it("edit and merge saves the merged text", async () => {
    signInAs("demo");
    await renderRoute("/conflicts/c-shopping");
    fireEvent.click(await screen.findByRole("button", { name: "Modifica e unisci…" }));
    expect(diffCalls.at(-1)).toEqual({ layout: "split", editable: true });
    fireEvent.click(screen.getByRole("button", { name: "Salva l'unione" }));
    expect(await screen.findByText("Unione salvata.")).toBeDefined();
  });

  it("stale: reload and warning, no success", async () => {
    signInAs("demo");
    await renderRoute("/conflicts/c-shopping");
    simulateStaleNext();
    fireEvent.click(await screen.findByRole("button", { name: "Tieni la mia" }));
    expect(await screen.findByText(/È arrivata una versione più recente/)).toBeDefined();
    expect(screen.queryByText(/Hai tenuto la tua versione/)).toBeNull();
    expect(ud.conflicts.some((c) => c.id === "c-shopping")).toBe(true);
  });

  it("binary: previews, no edit", async () => {
    signInAs("demo");
    await renderRoute("/conflicts/c-photo");
    expect(await screen.findAllByRole("img")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Modifica e unisci…" })).toBeNull();
  });

  it("against the real server, resolving is disabled and says it is coming", async () => {
    features.historyWrites = false;
    signInAs("demo");
    await renderRoute("/conflicts");
    const keep = (await screen.findByRole("button", { name: "Tieni la mia" })) as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    expect(screen.getByText("In arrivo: per ora puoi solo consultare.")).toBeDefined();
    const all = screen.getByRole("button", { name: "Risolvi tutti…" }) as HTMLButtonElement;
    expect(all.disabled).toBe(true);
  });

  it("resolve all needs an explicit choice", async () => {
    signInAs("demo");
    await renderRoute("/conflicts");
    fireEvent.click(await screen.findByRole("button", { name: "Risolvi tutti…" }));
    const dialog = await screen.findByRole("dialog");
    const apply = within(dialog).getByRole("button", { name: "Applica" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText("Tieni entrambe per tutti"));
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    expect(await screen.findByText("Conflitti risolti: 3")).toBeDefined();
    expect(await screen.findByText("Nessun conflitto da risolvere.")).toBeDefined();
  });
});

describe("ConflictCenter safety", () => {
  it("resolved elsewhere during a merge: says so and keeps the merged text", async () => {
    signInAs("demo");
    await renderRoute("/conflicts/c-shopping");
    fireEvent.click(await screen.findByRole("button", { name: "Modifica e unisci…" }));
    ud.conflicts = ud.conflicts.filter((c) => c.id !== "c-shopping"); // resolved on another device
    fireEvent.click(screen.getByRole("button", { name: "Salva l'unione" }));
    expect(await screen.findByText("Questo conflitto è già stato risolto.")).toBeDefined();
    expect(screen.getByText("merged text")).toBeDefined();
  });

  it("a load error is not reported as already resolved", async () => {
    server.use(
      http.get("*/api/v1/conflicts/:id", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "x", retryable: true } },
          { status: 500 },
        ),
      ),
    );
    signInAs("demo");
    await renderRoute("/conflicts/c-shopping");
    expect(await screen.findByText("Qualcosa è andato storto. Riprova.")).toBeDefined();
    expect(screen.queryByText("Questo conflitto è già stato risolto.")).toBeNull();
    expect(screen.getByRole("button", { name: "Riprova" })).toBeDefined();
  });
});

describe("ConflictCenter (phone)", () => {
  it("list and detail are separate pages; detail uses tabs + unified diff", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("max-width"),
      addEventListener() {},
      removeEventListener() {},
    }));
    signInAs("demo");
    await renderRoute("/conflicts");
    await screen.findByText("Spesa.md");
    expect(screen.queryByRole("heading", { name: "Spesa.md" })).toBeNull();
    cleanup();
    await renderRoute("/conflicts/c-shopping");
    expect(await screen.findByRole("tab", { name: "Differenze" })).toBeDefined();
    expect(diffCalls.at(-1)).toEqual({ layout: "unified", editable: false });
    expect(screen.getByRole("link", { name: "Tutti i conflitti" })).toBeDefined();
  });
});
