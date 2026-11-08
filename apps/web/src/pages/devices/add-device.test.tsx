// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/endpoints.js";
import { signInAs } from "../../mocks/db.js";
import { simulatePairingRequest, ud } from "../../mocks/userdata.js";
import { renderRoute } from "../../test/render.js";

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function openDialog() {
  signInAs("demo");
  await renderRoute("/vaults/v-notes?tab=devices");
  fireEvent.click(await screen.findByRole("button", { name: "Aggiungi un dispositivo" }));
  return screen.findByRole("dialog");
}

describe("AddDeviceDialog", () => {
  it("shows QR and link, then the request with the code; approve", async () => {
    const dialog = await openDialog();
    expect(
      await within(dialog).findByAltText("Codice QR per collegare un dispositivo"),
    ).toBeDefined();
    expect(
      (within(dialog).getByLabelText("Link di collegamento") as HTMLInputElement).value,
    ).toContain("obsidian://");
    act(() => simulatePairingRequest());
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(await within(dialog).findByText("K7RX")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approva" }));
    expect(await within(dialog).findByText("Dispositivo collegato.")).toBeDefined();
    expect(ud.devices.some((d) => d.name === "Pixel")).toBe(true);
  });

  it("deny", async () => {
    const dialog = await openDialog();
    await within(dialog).findByAltText("Codice QR per collegare un dispositivo");
    act(() => simulatePairingRequest());
    await act(() => vi.advanceTimersByTimeAsync(2100));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Rifiuta" }));
    expect(await within(dialog).findByText("Richiesta rifiutata.")).toBeDefined();
  });

  it("closing while waiting cancels the pairing and stops polling", async () => {
    const dialog = await openDialog();
    await within(dialog).findByAltText("Codice QR per collegare un dispositivo");
    const cancel = vi.spyOn(api, "cancelPairing");
    const poll = vi.spyOn(api, "pairing");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(cancel).toHaveBeenCalled());
    poll.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(poll).not.toHaveBeenCalled();
  });

  it("with several vaults, reopening asks for the vault again", async () => {
    signInAs("demo");
    await renderRoute("/");
    fireEvent.click(await screen.findByRole("button", { name: "Aggiungi un dispositivo" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Note" }));
    await within(dialog).findByAltText("Codice QR per collegare un dispositivo");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Aggiungi un dispositivo" }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Quale vault?")).toBeDefined();
  });
});
