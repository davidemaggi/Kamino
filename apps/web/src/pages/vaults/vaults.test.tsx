// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { signInAs } from "../../mocks/db.js";
import { renderRoute } from "../../test/render.js";

afterEach(cleanup);

describe("Vaults", () => {
  it("list → detail with header and devices tab", async () => {
    signInAs("demo");
    const { router } = await renderRoute("/vaults");
    fireEvent.click(await screen.findByRole("link", { name: /Note/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/vaults/v-notes"));
    expect(await screen.findByRole("heading", { name: "Note" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Dispositivi" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(await screen.findByText("MacBook")).toBeDefined();
  });

  it("tabs follow the URL", async () => {
    signInAs("demo");
    const { router } = await renderRoute("/vaults/v-notes?tab=conflicts");
    expect(await screen.findByText("Spesa.md")).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: "Impostazioni" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: "settings" }));
  });

  it("unknown vault", async () => {
    signInAs("demo");
    await renderRoute("/vaults/nope");
    expect(await screen.findByText("Vault non trovato.")).toBeDefined();
  });
});
