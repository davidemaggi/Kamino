// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ad, simulateSmtpFailure } from "../../mocks/admindata.js";
import { signInAs } from "../../mocks/db.js";
import { renderRoute } from "../../test/render.js";

afterEach(cleanup);

describe("Admin system", () => {
  it("config: env fields are locked and labelled", async () => {
    signInAs("admin");
    await renderRoute("/admin/system");
    const maxFile = (await screen.findByLabelText(
      "Dimensione massima di un file (MB)",
    )) as HTMLInputElement;
    expect(maxFile.disabled).toBe(true);
    expect((screen.getByLabelText("Server SMTP") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText("Impostato dall'ambiente").length).toBeGreaterThanOrEqual(2);
  });

  it("config: save registration and SMTP port; password write-only", async () => {
    signInAs("admin");
    await renderRoute("/admin/system?tab=config");
    fireEvent.click(await screen.findByLabelText("Aperta a tutti"));
    const reg = screen.getByRole("region", { name: "Registrazione" });
    fireEvent.click(within(reg).getByRole("button", { name: "Salva" }));
    await waitFor(() => expect(ad.config.registration.value).toBe("open"));
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Porta"), { target: { value: "465" } });
    const email = screen.getByRole("region", { name: "Email" });
    fireEvent.click(within(email).getByRole("button", { name: "Salva" }));
    await waitFor(() => expect(ad.config.smtp.port.value).toBe(465));
    expect(ad.config.smtp.password).toBe("secret");
  });

  it("test email: success and detailed failure", async () => {
    signInAs("admin");
    await renderRoute("/admin/system");
    fireEvent.click(await screen.findByRole("button", { name: "Invia email di prova" }));
    expect(await screen.findByText("Email di prova inviata al tuo indirizzo.")).toBeDefined();
    simulateSmtpFailure();
    fireEvent.click(screen.getByRole("button", { name: "Invia email di prova" }));
    expect(await screen.findByText(/535 5\.7\.8/)).toBeDefined();
  });

  it("health: status, checks with text, aggregate totals", async () => {
    signInAs("admin");
    await renderRoute("/admin/system?tab=health");
    expect(await screen.findByText("Qualcosa va controllato")).toBeDefined();
    expect(screen.getByText(/85% usato/)).toBeDefined();
    const totals = screen.getByRole("heading", { name: "Totali" }).parentElement!;
    expect(within(totals).getByText("Utenti")).toBeDefined();
  });

  it("audit: localized actions and pagination", async () => {
    signInAs("admin");
    await renderRoute("/admin/system?tab=audit");
    expect(await screen.findByText(/Pagina 1 di 2/)).toBeDefined();
    expect(screen.getAllByText("Utente creato").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Meno recenti" }));
    expect(await screen.findByText(/Pagina 2 di 2/)).toBeDefined();
  });
});
