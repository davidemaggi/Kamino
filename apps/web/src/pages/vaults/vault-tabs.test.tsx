// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/endpoints.js";
import { signInAs } from "../../mocks/db.js";
import { ud } from "../../mocks/userdata.js";
import { renderRoute } from "../../test/render.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("History and trash", () => {
  it("search, open a file history, preview and restore a version", async () => {
    signInAs("demo");
    await renderRoute("/vaults/v-notes?tab=history");
    fireEvent.change(await screen.findByLabelText("Cerca un file"), { target: { value: "idee" } });
    fireEvent.click(await screen.findByRole("button", { name: /Idee\.md/ }));
    const dialog = await screen.findByRole("dialog");
    const items = await within(dialog).findAllByRole("button", { name: /MacBook|iPhone/ });
    fireEvent.click(items[1]!);
    expect(await within(dialog).findByText(/Versione 3 delle idee/)).toBeDefined();
    const before = ud.files.find((f) => f.fileId === "f-idee")!.versions.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Ripristina questa versione" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Conferma il ripristino" }));
    await waitFor(() =>
      expect(ud.files.find((f) => f.fileId === "f-idee")!.versions.length).toBe(before + 1),
    );
  });

  it("trash: restore a file", async () => {
    signInAs("demo");
    await renderRoute("/vaults/v-notes?tab=history");
    const trash = await screen.findByRole("region", { name: "Cestino" });
    expect(within(trash).getByText(/almeno 7 giorni/)).toBeDefined();
    fireEvent.click((await within(trash).findAllByRole("button", { name: "Ripristina" }))[0]!);
    await waitFor(() => expect(ud.trash.filter((x) => x.vaultId === "v-notes")).toHaveLength(1));
  });
});

describe("Vault settings", () => {
  it("rename and retention", async () => {
    signInAs("demo");
    await renderRoute("/vaults/v-notes?tab=settings");
    fireEvent.change(await screen.findByLabelText("Nome del vault"), {
      target: { value: "Appunti" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rinomina" }));
    await waitFor(() => expect(ud.vaults.find((v) => v.id === "v-notes")!.name).toBe("Appunti"));
    fireEvent.change(screen.getByLabelText("Storico delle versioni"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Salva" }));
    await waitFor(() => expect(ud.vaults.find((v) => v.id === "v-notes")!.retentionDays).toBe(60));
  });

  it("ZIP: outside the history window shows the error", async () => {
    signInAs("demo");
    const spy = vi.spyOn(api, "downloadZip");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    await renderRoute("/vaults/v-notes?tab=settings");
    fireEvent.click(await screen.findByLabelText("Com'era il…"));
    fireEvent.change(screen.getByLabelText("Data e ora"), {
      target: { value: "2020-01-01T10:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Scarica" }));
    expect(
      await screen.findByText("Quel momento è fuori dallo storico disponibile."),
    ).toBeDefined();
    expect(spy).toHaveBeenCalledWith("v-notes", expect.stringContaining("2020-01-01"));
  });

  it("delete requires the exact name", async () => {
    signInAs("demo");
    const { router } = await renderRoute("/vaults/v-work?tab=settings");
    fireEvent.click(await screen.findByRole("button", { name: "Elimina il vault" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Elimina definitivamente",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Scrivi il nome del vault per confermare"), {
      target: { value: "lavoro" },
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Scrivi il nome del vault per confermare"), {
      target: { value: "Lavoro" },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe("/vaults"));
    expect(ud.vaults.some((v) => v.id === "v-work")).toBe(false);
  });

  it("shortening the history asks for confirmation", async () => {
    signInAs("demo");
    await renderRoute("/vaults/v-notes?tab=settings");
    fireEvent.change(await screen.findByLabelText("Storico delle versioni"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salva" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/più vecchie di 7 giorni/)).toBeDefined();
    expect(ud.vaults.find((v) => v.id === "v-notes")!.retentionDays).toBe(30);
    fireEvent.click(within(dialog).getByRole("button", { name: "Riduci" }));
    await waitFor(() => expect(ud.vaults.find((v) => v.id === "v-notes")!.retentionDays).toBe(7));
  });
});
