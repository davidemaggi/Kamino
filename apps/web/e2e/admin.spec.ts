import { expect, test } from "@playwright/test";
import { currentTotp } from "./totp.js";

/** Seeded by apps/server/test/e2e-server.ts: admin "root" (TOTP on), users "mario" and "luigi". */
const PW = "Qp7#vT2!mZx9-long";

test("admin area on the real server: users, block, system health", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Nome utente").fill("root");
  await page.getByLabel("Password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Accedi" }).click();
  await page.getByLabel("Codice", { exact: true }).fill(currentTotp());
  await page.getByRole("button", { name: "Verifica" }).click();

  // Users: aggregates only, never vault names.
  await page.goto("/admin/users");
  await expect(page.getByRole("heading", { name: "Utenti" })).toBeVisible();
  await expect(page.getByText(/Per privacy non vedi nomi di vault/)).toBeVisible();
  await expect(page.getByText("Note")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "mario" })).toBeVisible();
  await page.getByRole("link", { name: "luigi" }).click();

  // Block and unblock luigi (mario is in use by the user-area test running in parallel).
  await page.getByRole("button", { name: "Blocca" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Blocca" }).click();
  await expect(page.getByText("Bloccato").first()).toBeVisible();
  await page.getByRole("button", { name: "Sblocca" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sblocca" }).click();
  await expect(page.getByRole("button", { name: "Blocca" })).toBeVisible();

  // System: health from the real checks.
  await page.goto("/admin/system");
  await page.getByRole("tab", { name: "Salute" }).click();
  await expect(page.getByText(/database/i).first()).toBeVisible();
});
