// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { signInAs } from "../../mocks/db.js";
import { seedUserData, ud } from "../../mocks/userdata.js";
import { renderRoute } from "../../test/render.js";

afterEach(cleanup);

describe("OverviewPage", () => {
  it("shows space, vault cards and devices to check", async () => {
    signInAs("demo");
    await renderRoute("/");
    expect(await screen.findByText(/di 10 GB/)).toBeDefined();
    expect(screen.queryByText(/Spazio quasi esaurito/)).toBeNull();
    const vaults = screen.getByRole("region", { name: "Vault" });
    expect(within(vaults).getByText("Note")).toBeDefined();
    expect(within(vaults).getByText("Lavoro")).toBeDefined();
    const attention = screen.getByRole("region", { name: "Dispositivi da guardare" });
    expect(within(attention).getByText("iPhone")).toBeDefined();
    expect(within(attention).getByText("iPad")).toBeDefined();
    expect(within(attention).queryByText("MacBook")).toBeNull();
  });

  it("warns at 90% of the quota", async () => {
    seedUserData("quota-almost-full");
    signInAs("demo");
    await renderRoute("/");
    expect(await screen.findByText(/Spazio quasi esaurito/)).toBeDefined();
  });

  it("no vaults: explains to create one from the plugin", async () => {
    ud.vaults = [];
    ud.devices = [];
    signInAs("demo");
    await renderRoute("/");
    expect(await screen.findByText(/Il primo si crea da Obsidian/)).toBeDefined();
  });
});
