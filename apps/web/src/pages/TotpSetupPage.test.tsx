// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { signInAs, TEST_TOTP } from "../mocks/db.js";
import { renderRoute } from "../test/render.js";

afterEach(cleanup);

describe("TotpSetupPage", () => {
  it("required for a new admin: QR, wrong code, codes, ack, then the app", async () => {
    signInAs("newadmin");
    const { router } = await renderRoute("/account/totp-setup");
    expect(await screen.findByText(/obbligatoria: configurala per continuare/)).toBeDefined();
    expect(
      (await screen.findByAltText("Codice QR per l'app di autenticazione")).getAttribute("src"),
    ).toMatch(/^data:image\/svg\+xml,/);
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Codice", { selector: "input" }), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verifica" }));
    expect(await screen.findByText("Codice non corretto.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Codice", { selector: "input" }), {
      target: { value: TEST_TOTP },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verifica" }));
    expect(await screen.findAllByTestId("recovery-code")).toHaveLength(10);
    const finish = screen.getByRole("button", { name: "Fine" }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Li ho salvati in un posto sicuro"));
    expect(finish.disabled).toBe(false);
    fireEvent.click(finish);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("the navigation is hidden while the setup is required", async () => {
    signInAs("newadmin");
    await renderRoute("/account/totp-setup");
    await screen.findByText(/obbligatoria/);
    expect(screen.queryByText("Panoramica")).toBeNull();
    expect(screen.getAllByText("Esci").length).toBeGreaterThan(0);
  });
});
