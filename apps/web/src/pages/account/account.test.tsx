// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { db, signInAs } from "../../mocks/db.js";
import { renderRoute } from "../../test/render.js";

afterEach(cleanup);

const section = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest("section")!;
const typeIn = (root: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(root).getByLabelText(label, { selector: "input" }), {
    target: { value },
  });

describe("AccountPage", () => {
  it("profile: saves the email", async () => {
    signInAs("demo");
    await renderRoute("/account", "it");
    const s = await section("Profilo");
    typeIn(s, "Email", "new@example.com");
    fireEvent.click(within(s).getByRole("button", { name: "Salva" }));
    await waitFor(() =>
      expect(db.users.find((u) => u.username === "demo")!.email).toBe("new@example.com"),
    );
  });

  it("password: wrong current password, then success", async () => {
    signInAs("demo");
    await renderRoute("/account");
    const s = await section("Password");
    typeIn(s, "Password attuale", "nope");
    typeIn(s, "Nuova password", "another-pass-12");
    typeIn(s, "Ripeti la password", "another-pass-12");
    fireEvent.click(within(s).getByRole("button", { name: "Cambia la password" }));
    expect(await within(s).findByText("La password attuale non è corretta.")).toBeDefined();
    typeIn(s, "Password attuale", "demo-password-1");
    fireEvent.click(within(s).getByRole("button", { name: "Cambia la password" }));
    expect(await within(s).findByText("Password cambiata.")).toBeDefined();
  });

  it("TOTP: admins cannot turn it off", async () => {
    signInAs("admin");
    await renderRoute("/account");
    const s = await section("Verifica in due passaggi");
    expect(within(s).queryByRole("button", { name: "Disattiva" })).toBeNull();
    expect(within(s).getByText("Per gli amministratori è obbligatoria.")).toBeDefined();
  });

  it("TOTP: a user turns it off with the password", async () => {
    signInAs("demo");
    db.users.find((u) => u.username === "demo")!.totpEnabled = true;
    await renderRoute("/account");
    const s = await section("Verifica in due passaggi");
    fireEvent.click(within(s).getByRole("button", { name: "Disattiva" }));
    typeIn(s, "Conferma con la tua password", "demo-password-1");
    fireEvent.click(within(s).getByRole("button", { name: "Conferma" }));
    await waitFor(() =>
      expect(db.users.find((u) => u.username === "demo")!.totpEnabled).toBe(false),
    );
  });

  it("sessions: current marked, sign out of the others", async () => {
    signInAs("admin");
    await renderRoute("/account");
    const s = await section("Sessioni attive");
    expect(await within(s).findByText("Questa sessione")).toBeDefined();
    expect(within(s).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(within(s).getByRole("button", { name: "Esci da tutte le altre" }));
    await waitFor(() => expect(within(s).getAllByRole("listitem")).toHaveLength(1));
  });

  it("security log: localized entries and pagination", async () => {
    signInAs("admin");
    await renderRoute("/account");
    const s = await section("Registro di sicurezza");
    expect(await within(s).findByText(/Pagina 1 di 2/)).toBeDefined();
    expect(within(s).getAllByRole("listitem").length).toBe(20);
    fireEvent.click(within(s).getByRole("button", { name: "Meno recenti" }));
    expect(await within(s).findByText(/Pagina 2 di 2/)).toBeDefined();
  });
});
