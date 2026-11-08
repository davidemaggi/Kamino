// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resetDb, signInAs } from "./mocks/db.js";
import { renderRoute } from "./test/render.js";

afterEach(cleanup);

describe("route guards", () => {
  it("not signed in → login, keeping the target", async () => {
    const { router } = await renderRoute("/account");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toMatchObject({ redirect: "/account" });
  });

  it("no users on the server → setup", async () => {
    resetDb("empty");
    const { router } = await renderRoute("/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
  });

  it("admin without TOTP → TOTP setup, whatever the URL", async () => {
    signInAs("newadmin");
    const { router } = await renderRoute("/vaults");
    await waitFor(() => expect(router.state.location.pathname).toBe("/account/totp-setup"));
  });

  it("a user cannot open the admin area", async () => {
    signInAs("demo");
    await renderRoute("/admin/users");
    expect(await screen.findByText("Pagina non trovata.")).toBeDefined();
  });

  it("signed in on a public page → overview", async () => {
    signInAs("demo");
    const { router } = await renderRoute("/login");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });
});
