// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { db, resetDb, signInAs } from "./mocks/db.js";
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

  it("a session revoked mid-session sends the user to sign-in, keeping the page", async () => {
    signInAs("demo");
    const { router } = await renderRoute("/account");
    await screen.findByRole("heading", { name: "Profilo" });
    db.currentSessionId = null; // revoked from another device
    fireEvent.click(screen.getByRole("button", { name: "Salva" })); // PATCH /account/profile → 401
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toMatchObject({ redirect: "/account" });
  });

  it("the TOTP setup page is not reachable once TOTP is on", async () => {
    signInAs("admin");
    const { router } = await renderRoute("/account/totp-setup");
    await waitFor(() => expect(router.state.location.pathname).toBe("/account"));
  });

  it("/admin goes to the users page for admins", async () => {
    signInAs("admin");
    const { router } = await renderRoute("/admin");
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/users"));
  });
});
