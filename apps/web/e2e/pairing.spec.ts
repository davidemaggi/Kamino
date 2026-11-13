import { expect, test } from "@playwright/test";

/** Seeded by apps/server/test/e2e-server.ts; the new device is simulated with direct API calls. */
const USER = "mario";
const PW = "Qp7#vT2!mZx9-long";
const API = "http://127.0.0.1:8181/api/v1";
const HEADERS = { "kamino-protocol": "1" };

test("pairing from the web on the real server: QR link, same code, approve", async ({
  page,
  request,
}) => {
  await page.goto("/login");
  await page.getByLabel("Nome utente").fill(USER);
  await page.getByLabel("Password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Accedi" }).click();

  await page.getByRole("link", { name: /Note/ }).first().click();
  await page.getByRole("tab", { name: "Dispositivi" }).click();
  await page.getByRole("button", { name: "Aggiungi un dispositivo" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("img", { name: "Codice QR per collegare un dispositivo" }),
  ).toBeVisible();
  const link = await dialog.getByLabel("Link di collegamento").inputValue();
  const token = new URL(link).searchParams.get("token")!;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

  // The new device scans the code and claims the pairing.
  const claim = await request.post(`${API}/pairings/claim`, {
    headers: HEADERS,
    data: {
      token,
      deviceName: "Pixel",
      platform: "android",
      pluginVersion: "0.2.0",
      protocolVersion: 1,
    },
  });
  expect(claim.status()).toBe(200);
  const { claimId, claimSecret, verificationCode } = (await claim.json()) as {
    claimId: string;
    claimSecret: string;
    verificationCode: string;
  };

  // The web app shows the request with the same code.
  await expect(dialog.getByText("Nuovo dispositivo: “Pixel”")).toBeVisible();
  await expect(dialog.getByText(verificationCode, { exact: true })).toBeVisible();
  // Someone else tries the same link: refused, and the web app warns before approving.
  const again = await request.post(`${API}/pairings/claim`, {
    headers: HEADERS,
    data: {
      token,
      deviceName: "Other",
      platform: "linux",
      pluginVersion: "0.2.0",
      protocolVersion: 1,
    },
  });
  expect(again.status()).toBe(409);
  await expect(
    dialog.getByText("Il link è stato usato anche da un altro dispositivo"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Approva" }).click();
  await expect(dialog.getByText("Dispositivo collegato.")).toBeVisible();

  // The new device receives its token, once, and it works.
  const poll = await request.get(`${API}/pairings/claims/${claimId}`, {
    headers: { ...HEADERS, authorization: `Claim ${claimSecret}` },
  });
  const state = (await poll.json()) as { status: string; deviceToken: string };
  expect(state.status).toBe("approved");
  const me = await request.get(`${API}/device`, {
    headers: { ...HEADERS, authorization: `Bearer ${state.deviceToken}` },
  });
  expect(me.status()).toBe(200);

  await dialog.getByRole("button", { name: "Chiudi" }).first().click();
  await expect(page.getByText("Pixel")).toBeVisible();
});
