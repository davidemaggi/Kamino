// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ad } from "../../mocks/admindata.js";
import { db, signInAs } from "../../mocks/db.js";
import { ud } from "../../mocks/userdata.js";
import { renderRoute } from "../../test/render.js";

afterEach(cleanup);
const idOf = (u: string) => db.users.find((x) => x.username === u)!.id;

describe("Admin users", () => {
  it("list shows aggregates and never vault names", async () => {
    signInAs("admin");
    await renderRoute("/admin/users");
    expect(await screen.findByText("demo")).toBeDefined();
    expect(screen.getAllByText(/illimitata/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Per privacy non vedi nomi di vault/)).toBeDefined();
    for (const v of ud.vaults) expect(screen.queryByText(v.name)).toBeNull();
  });

  it("create with a link shown once; email disabled without SMTP", async () => {
    db.smtp = false;
    signInAs("admin");
    await renderRoute("/admin/users");
    fireEvent.click(await screen.findByRole("button", { name: "Crea utente" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      (within(dialog).getByLabelText("Invia invito via email") as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Nome utente"), { target: { value: "nuovo" } });
    fireEvent.change(within(dialog).getByLabelText("Email"), {
      target: { value: "nuovo@example.com" },
    });
    fireEvent.click(within(dialog).getByLabelText("Genera un link di attivazione"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Crea" }));
    const link = (await within(dialog).findByLabelText("Link")) as HTMLInputElement;
    expect(link.value).toContain("/invite/");
  });

  it("detail: quota warning, role last admin, block with confirmation", async () => {
    signInAs("admin");
    await renderRoute(`/admin/users/${idOf("demo")}`);
    expect(await screen.findByRole("heading", { name: "demo" })).toBeDefined();
    fireEvent.click(screen.getByLabelText("Illimitata"));
    fireEvent.change(screen.getByLabelText("Quota in GB"), { target: { value: "0.1" } });
    expect(screen.getByText(/sotto lo spazio già usato/)).toBeDefined();
    fireEvent.click(
      within(screen.getByRole("region", { name: "Quota" })).getByRole("button", { name: "Salva" }),
    );
    await waitFor(() =>
      expect(ad.meta.get(idOf("demo"))!.quotaBytes).toBeCloseTo(0.1 * 1024 ** 3, -3),
    );
    fireEvent.click(screen.getByRole("button", { name: "Blocca" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/I dati restano intatti/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Blocca" }));
    await waitFor(() => expect(db.users.find((u) => u.username === "demo")!.locked).toBe(true));
  });

  it("removing admin from the last admin is explained", async () => {
    db.users.find((u) => u.username === "newadmin")!.role = "user";
    signInAs("admin");
    await renderRoute(`/admin/users/${idOf("admin")}`);
    fireEvent.change(await screen.findByRole("combobox", { name: "Ruolo" }), {
      target: { value: "user" },
    });
    fireEvent.click(
      within(screen.getByRole("region", { name: "Ruolo" })).getByRole("button", { name: "Salva" }),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Togli il ruolo" }),
    );
    expect(await screen.findByText("Serve almeno un amministratore.")).toBeDefined();
    // The select goes back to the real role.
    expect((screen.getByRole("combobox", { name: "Ruolo" }) as HTMLSelectElement).value).toBe(
      "admin",
    );
  });

  it("self: no block or delete", async () => {
    signInAs("admin");
    await renderRoute(`/admin/users/${idOf("admin")}`);
    expect(await screen.findByText(/non puoi bloccarti né eliminarti/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Elimina l'utente" })).toBeNull();
  });

  it("reset link after confirmation, shown once", async () => {
    signInAs("admin");
    await renderRoute(`/admin/users/${idOf("demo")}`);
    fireEvent.click(
      await screen.findByRole("button", { name: "Link per reimpostare la password" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Genera" }));
    expect(((await screen.findByLabelText("Link")) as HTMLInputElement).value).toContain("/reset/");
  });

  it("delete needs the exact username; ZIP only with SMTP", async () => {
    signInAs("admin");
    const { router } = await renderRoute(`/admin/users/${idOf("demo")}`);
    fireEvent.click(await screen.findByRole("button", { name: "Elimina l'utente" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Elimina" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Scrivi il nome utente per confermare"), {
      target: { value: "demo" },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/users"));
    expect(ad.meta.get(idOf("demo"))!.deletionAt).not.toBeNull();
  });
  it("invalid quota can't be saved", async () => {
    signInAs("admin");
    await renderRoute(`/admin/users/${idOf("demo")}`);
    fireEvent.click(await screen.findByLabelText("Illimitata"));
    fireEvent.change(screen.getByLabelText("Quota in GB"), { target: { value: "-5" } });
    expect(screen.getByText("Inserisci un numero maggiore di zero.")).toBeDefined();
    const quota = screen.getByRole("region", { name: "Quota" });
    expect(
      (within(quota).getByRole("button", { name: "Salva" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("demoting yourself asks first, then leaves the admin area", async () => {
    signInAs("admin");
    const { router } = await renderRoute(`/admin/users/${idOf("admin")}`);
    fireEvent.change(await screen.findByRole("combobox", { name: "Ruolo" }), {
      target: { value: "user" },
    });
    fireEvent.click(
      within(screen.getByRole("region", { name: "Ruolo" })).getByRole("button", { name: "Salva" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Togli il ruolo" }));
    await waitFor(() => expect(router.state.location.pathname).not.toMatch(/^\/admin/));
    expect(db.users.find((u) => u.username === "admin")!.role).toBe("user");
  });

  it("unblock with confirmation", async () => {
    signInAs("admin");
    await renderRoute(`/admin/users/${idOf("locked")}`);
    fireEvent.click(await screen.findByRole("button", { name: "Sblocca" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Sblocca" }));
    await waitFor(() => expect(db.users.find((u) => u.username === "locked")!.locked).toBe(false));
  });

  it("ZIP option disabled without SMTP", async () => {
    db.smtp = false;
    signInAs("admin");
    await renderRoute(`/admin/users/${idOf("demo")}`);
    fireEvent.click(await screen.findByRole("button", { name: "Elimina l'utente" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByText("Serve l'invio di email per mandare lo ZIP.")).toBeDefined();
  });

  it("create with an email invitation", async () => {
    signInAs("admin");
    await renderRoute("/admin/users");
    fireEvent.click(await screen.findByRole("button", { name: "Crea utente" }));
    const dialog = await screen.findByRole("dialog");
    const byEmail = within(dialog).getByLabelText("Invia invito via email") as HTMLInputElement;
    await waitFor(() => expect(byEmail.disabled).toBe(false));
    fireEvent.click(byEmail);
    fireEvent.change(within(dialog).getByLabelText("Nome utente"), { target: { value: "nuovo" } });
    fireEvent.change(within(dialog).getByLabelText("Email"), {
      target: { value: "nuovo@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Crea" }));
    expect(await within(dialog).findByText("Invito inviato a nuovo@example.com.")).toBeDefined();
    expect(within(dialog).queryByLabelText("Link")).toBeNull();
  });
});
