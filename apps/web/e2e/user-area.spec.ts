import { expect, test } from "@playwright/test";

/** Seeded by apps/server/test/e2e-server.ts. */
const USER = "mario";
const PW = "Qp7#vT2!mZx9-long";

test("user area on the real server: vault, history, trash, conflicts, ZIP", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Nome utente").fill(USER);
  await page.getByLabel("Password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Accedi" }).click();

  await page.getByRole("link", { name: /Note/ }).first().click();
  await expect(page.getByRole("heading", { name: "Note" })).toBeVisible();

  // History: search, versions, preview; restoring is not there yet.
  await page.getByRole("tab", { name: "Storico e cestino" }).click();
  await page.getByLabel("Cerca un file").fill("a.md");
  await page.getByRole("button", { name: /a\.md/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Mac/ }).last().click();
  await expect(dialog.getByText("first version")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Ripristina questa versione" })).toBeDisabled();
  await page.keyboard.press("Escape");

  const trash = page.getByRole("region", { name: "Cestino" });
  await expect(trash.getByText("gone.md")).toBeVisible();
  await expect(trash.getByRole("button", { name: "Ripristina" })).toBeDisabled();

  // ZIP of the current state.
  await page.getByRole("tab", { name: "Impostazioni" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Scarica", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);

  // Conflicts: both sides are readable, resolving is not there yet.
  await page.goto("/conflicts");
  await expect(page.getByText("In arrivo: per ora puoi solo consultare.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tieni la mia" })).toBeDisabled();
});
