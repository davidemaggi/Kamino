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
    fireEvent.click(screen.getAllByRole("button", { name: "Salva" })[0]!);
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
    fireEvent.change(await screen.findByLabelText("Ruolo"), { target: { value: "user" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Salva" })[1]!);
    expect(await screen.findByText("Serve almeno un amministratore.")).toBeDefined();
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
});
