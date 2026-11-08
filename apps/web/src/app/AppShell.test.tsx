// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { signInAs } from "../mocks/db.js";
import { renderRoute } from "../test/render.js";

afterEach(cleanup);

describe("AppShell", () => {
  it("shows the navigation, the overall status and the conflicts count", async () => {
    signInAs("demo");
    await renderRoute("/");
    const nav = await screen.findByRole("navigation", { name: "Navigazione principale" });
    for (const label of ["Panoramica", "Vault", "Dispositivi", "Conflitti", "Account"]) {
      expect(within(nav).getAllByText(label, { exact: false }).length).toBeGreaterThan(0);
    }
    expect(within(nav).queryByText("Amministrazione")).toBeNull();
    expect(await within(nav).findByText("Conflitti da risolvere")).toBeDefined();
    expect(within(nav).getByText("2")).toBeDefined();
    expect(
      within(nav)
        .getByRole("link", { name: /Panoramica/ })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("admins see the administration section", async () => {
    signInAs("admin");
    await renderRoute("/");
    const nav = await screen.findByRole("navigation", { name: "Navigazione principale" });
    expect(within(nav).getByText("Amministrazione")).toBeDefined();
  });

  it("shows the admin-reset banner until dismissed", async () => {
    signInAs("reset");
    await renderRoute("/");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("L'amministratore ha avviato il reset della tua password");
    within(alert).getByRole("button", { name: "Ho capito" }).click();
    await screen.findByRole("navigation", { name: "Navigazione principale" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("has a skip link and sets the document title", async () => {
    signInAs("demo");
    await renderRoute("/account");
    expect(await screen.findByText("Vai al contenuto")).toBeDefined();
    expect(document.title).toContain("Account");
  });
});
