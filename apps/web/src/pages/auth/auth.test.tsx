// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { db, resetDb, TEST_RECOVERY_CODES, TEST_TOTP } from "../../mocks/db.js";
import { renderRoute } from "../../test/render.js";

afterEach(cleanup);

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label, { selector: "input" }), { target: { value } });
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("LoginPage", () => {
  it("wrong credentials: message and empty password", async () => {
    await renderRoute("/login");
    type("Nome utente", "demo");
    type("Password", "nope");
    click("Accedi");
    expect(await screen.findByText("Nome utente o password non corretti.")).toBeDefined();
    expect(
      (screen.getByLabelText("Password", { selector: "input" }) as HTMLInputElement).value,
    ).toBe("");
  });

  it("blocked account", async () => {
    await renderRoute("/login");
    type("Nome utente", "locked");
    type("Password", "locked-password-1");
    click("Accedi");
    expect(await screen.findByText("Account bloccato: contatta l'amministratore.")).toBeDefined();
  });

  it("plain login goes to the internal redirect", async () => {
    const { router } = await renderRoute("/login?redirect=%2Faccount");
    type("Nome utente", "demo");
    type("Password", "demo-password-1");
    click("Accedi");
    await waitFor(() => expect(router.state.location.pathname).toBe("/account"));
  });

  it("an internal redirect with a query string is kept", async () => {
    const { router } = await renderRoute("/login?redirect=%2Fvaults%3Fx%3D1");
    type("Nome utente", "demo");
    type("Password", "demo-password-1");
    click("Accedi");
    await waitFor(() => expect(router.state.location.pathname).toBe("/vaults"));
    expect(router.state.location.searchStr).toBe("?x=1");
  });

  it("an external redirect is ignored", async () => {
    const { router } = await renderRoute("/login?redirect=https%3A%2F%2Fevil.example");
    type("Nome utente", "demo");
    type("Password", "demo-password-1");
    click("Accedi");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("TOTP step, wrong then right code", async () => {
    const { router } = await renderRoute("/login");
    type("Nome utente", "admin");
    type("Password", "admin-password-1");
    click("Accedi");
    expect(await screen.findByText("Codice di verifica")).toBeDefined();
    type("Codice", "000000");
    click("Verifica");
    expect(await screen.findByText("Codice non corretto.")).toBeDefined();
    type("Codice", TEST_TOTP);
    click("Verifica");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("recovery code", async () => {
    const { router } = await renderRoute("/login");
    type("Nome utente", "admin");
    type("Password", "admin-password-1");
    click("Accedi");
    fireEvent.click(await screen.findByRole("button", { name: "Usa un codice di recupero" }));
    type("Codice di recupero", TEST_RECOVERY_CODES[1]!);
    click("Verifica");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });
});

describe("SetupPage", () => {
  it("wrong token, weak password, then success → TOTP setup", async () => {
    resetDb("empty");
    const { router } = await renderRoute("/setup");
    expect(await screen.findByText(/log di avvio del server/)).toBeDefined();
    type("Codice di configurazione", "wrong");
    type("Nome utente", "boss");
    type("Email", "boss@example.com");
    type("Nuova password", "short");
    type("Ripeti la password", "short");
    click("Crea l'amministratore");
    expect(await screen.findByText("Almeno 12 caratteri.")).toBeDefined();
    type("Nuova password", "boss-password-1");
    type("Ripeti la password", "boss-password-1");
    click("Crea l'amministratore");
    expect(await screen.findByText("Codice di configurazione non corretto.")).toBeDefined();
    type("Codice di configurazione", "setup-token");
    click("Crea l'amministratore");
    await waitFor(() => expect(router.state.location.pathname).toBe("/account/totp-setup"));
  });
});

describe("ForgotPage", () => {
  it("same answer for unknown emails; no SMTP explains", async () => {
    await renderRoute("/forgot");
    type("Email", "nobody@example.com");
    click("Invia le istruzioni");
    expect(await screen.findByText(/Se l'indirizzo è registrato/)).toBeDefined();
    cleanup();
    db.smtp = false;
    await renderRoute("/forgot");
    type("Email", "demo@example.com");
    click("Invia le istruzioni");
    expect(await screen.findByText(/chiedi all'amministratore/)).toBeDefined();
  });
});

describe("ResetPage and InvitePage", () => {
  it("reset with a valid token, then the link is used up", async () => {
    await renderRoute("/reset/reset-token");
    type("Nuova password", "brand-new-pass-1");
    type("Ripeti la password", "brand-new-pass-1");
    click("Salva la password");
    expect(await screen.findByText("Password aggiornata: ora puoi accedere.")).toBeDefined();
  });

  it("mismatching passwords are caught before sending", async () => {
    await renderRoute("/reset/reset-token");
    type("Nuova password", "brand-new-pass-1");
    type("Ripeti la password", "brand-new-pass-2");
    click("Salva la password");
    expect(await screen.findByText("Le due password non coincidono.")).toBeDefined();
  });

  it("expired reset link", async () => {
    await renderRoute("/reset/expired-token");
    type("Nuova password", "brand-new-pass-1");
    type("Ripeti la password", "brand-new-pass-1");
    click("Salva la password");
    expect(await screen.findByText("Questo link è scaduto: chiedine uno nuovo.")).toBeDefined();
  });

  it("invite shows who is invited and creates the account", async () => {
    const { router } = await renderRoute("/invite/invite-token");
    expect(await screen.findByText(/invited@example.com/)).toBeDefined();
    type("Nuova password", "invited-pass-12");
    type("Ripeti la password", "invited-pass-12");
    click("Crea l'account");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("invalid invite", async () => {
    await renderRoute("/invite/nope");
    expect(await screen.findByText("Questo link non è valido.")).toBeDefined();
  });
});
