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

  // History: search, versions, preview, restore an old version.
  await page.getByRole("tab", { name: "Storico e cestino" }).click();
  await page.getByLabel("Cerca un file").fill("a.md");
  await page.getByRole("button", { name: /a\.md/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Mac/ }).last().click();
  await expect(dialog.getByText("first version")).toBeVisible();
  await dialog.getByRole("button", { name: "Ripristina questa versione" }).click();
  await dialog.getByRole("button", { name: "Conferma il ripristino" }).click();
  // The restored content is a new current version, written by the web app (no device).
  await expect(dialog.getByRole("button", { name: /—/ })).toBeVisible();
  await page.keyboard.press("Escape");

  // Trash: the deleted file comes back.
  const trash = page.getByRole("region", { name: "Cestino" });
  await expect(trash.getByText("gone.md")).toBeVisible();
  await trash.getByRole("button", { name: "Ripristina" }).click();
  await expect(trash.getByText("gone.md")).toBeHidden();

  // ZIP of the current state.
  await page.getByRole("tab", { name: "Impostazioni" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Scarica", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);

  // Conflicts: the restore above moved the head, so the conflict view reloads fresh; keep both.
  await page.goto("/conflicts");
  await page.getByRole("button", { name: "Tieni entrambe" }).click();
  await expect(page.getByText("Nessun conflitto da risolvere.")).toBeVisible();
});
