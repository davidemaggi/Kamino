import { describe, expect, it, vi } from "vitest";
import { App } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import type { UiContext } from "./context.js";
import { ConnectModal } from "./ConnectModal.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

function open(mode: "create" | "join", over: Partial<UiContext> = {}, files = 0) {
  const made = makeCtx(over);
  made.plugin.app.vault.files = Array.from({ length: files }, (_, i) => ({ path: `n${i}.md` }));
  const modal = new ConnectModal(new App() as never, made.ctx, mode);
  modal.open();
  const root = (modal as unknown as { contentEl: HTMLElement }).contentEl;
  const input = (label: string) =>
    root.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
  const type = (label: string, value: string) => {
    const el = input(label)!;
    el.value = value;
    el.dispatchEvent(new Event("input"));
  };
  const click = async (text: string) => {
    [...root.querySelectorAll("button")].find((b) => b.textContent === text)!.click();
    await flush();
  };
  return { ...made, modal, root, input, type, click };
}

async function toLogin(o: ReturnType<typeof open>, server = "https://sync.example") {
  o.type("Indirizzo del server", server);
  await o.click("Verifica");
}

describe("ConnectModal, server step", () => {
  it.each([
    ["nope", "Indirizzo non valido."],
    ["https://unreachable.example", "Server non raggiungibile"],
    ["https://old.example", "Versione del server non compatibile"],
  ])("%s -> error", async (server, message) => {
    const o = open("join");
    await toLogin(o, server);
    expect(o.root.textContent).toContain(message);
    expect(o.input("Nome utente")).toBeNull();
  });

  it("http on desktop: warning, then login", async () => {
    const o = open("join");
    await toLogin(o, "http://10.0.0.2:8080");
    expect(o.root.textContent).toContain("Connessione non cifrata");
    expect(o.input("Nome utente")).not.toBeNull();
  });

  it("http on mobile: blocked", async () => {
    const o = open("join", { isMobile: true });
    await toLogin(o, "http://10.0.0.2:8080");
    expect(o.root.textContent).toContain("Su telefono serve un indirizzo https://");
    expect(o.input("Nome utente")).toBeNull();
  });
});

describe("ConnectModal, login step", () => {
  it("wrong credentials, then TOTP", async () => {
    const o = open("join");
    await toLogin(o);
    o.type("Nome utente", "demo");
    o.type("Password", "nope");
    await o.click("Accedi");
    expect(o.root.textContent).toContain("Nome utente o password non corretti.");
    o.type("Nome utente", "demo2fa");
    o.type("Password", "demo");
    await o.click("Accedi");
    expect(o.input("Codice di verifica")).not.toBeNull();
    o.type("Codice di verifica", "000000");
    await o.click("Accedi");
    expect(o.root.textContent).toContain("Codice di verifica non corretto.");
  });

  it("the password is not kept after a failed sign-in", async () => {
    const o = open("join");
    await toLogin(o);
    o.type("Nome utente", "demo");
    o.type("Password", "wrong");
    await o.click("Accedi");
    expect(o.input("Password")!.value).toBe("");
    // The field looks empty: submitting again must not reuse the old password.
    await o.click("Accedi");
    expect(o.root.textContent).toContain("Compila questo campo.");
  });

  it("closing removes the password field", async () => {
    const o = open("join");
    await toLogin(o);
    o.type("Password", "secret");
    o.modal.close();
    expect(o.input("Password")).toBeNull();
  });

  it("Enter submits the current step", async () => {
    const o = open("join");
    o.type("Indirizzo del server", "https://sync.example");
    o.input("Indirizzo del server")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await flush();
    expect(o.input("Nome utente")).not.toBeNull();
  });
});

describe("ConnectModal, create flow", () => {
  it("creates the vault, links, starts the upload and opens the transfer view", async () => {
    const o = open("create", {}, 3);
    await toLogin(o);
    o.type("Nome utente", "demo");
    o.type("Password", "demo");
    await o.click("Accedi");
    expect(o.input("Nome del vault sul server")!.value).toBe("Prova");
    await o.click("Avanti");
    expect(o.input("Nome di questo dispositivo")!.value).toBe("macOS");
    const start = vi.spyOn(o.ctx.transfer, "start");
    await o.click("Crea e collega");
    expect(o.server.link()).toMatchObject({ vaultName: "Prova", deviceName: "macOS" });
    expect(start).toHaveBeenCalledWith("upload");
    expect(o.ctx.openTransfer).toHaveBeenCalled();
    expect((o.modal as unknown as { isOpen: boolean }).isOpen).toBe(false);
  });
});

describe("ConnectModal, join flow", () => {
  async function toVaults(o: ReturnType<typeof open>, user = "demo") {
    await toLogin(o);
    o.type("Nome utente", user);
    o.type("Password", "demo");
    if (user === "demo2fa") {
      await o.click("Accedi");
      o.type("Codice di verifica", "123456");
    }
    await o.click("Accedi");
  }

  it("empty vault list explains what to do", async () => {
    const o = open("join");
    await toVaults(o, "demo2fa");
    expect(o.root.textContent).toContain("Nessun vault su questo server");
  });

  it("with local files: reconciliation before linking", async () => {
    const o = open("join", {}, 12);
    await toVaults(o);
    (o.root.querySelector('input[type="radio"][value="v-notes"]') as HTMLInputElement).click();
    await o.click("Avanti");
    await o.click("Collega");
    expect(o.root.textContent).toContain("Questo vault contiene già 12 file");
    expect(o.server.link()).toBeNull();
    const start = vi.spyOn(o.ctx.transfer, "start");
    await o.click("Continua");
    expect(o.server.link()?.vaultId).toBe("v-notes");
    expect(start).toHaveBeenCalledWith("download");
  });

  it("empty local folder: links directly", async () => {
    const o = open("join", {}, 0);
    await toVaults(o);
    (o.root.querySelector('input[type="radio"][value="v-work"]') as HTMLInputElement).click();
    await o.click("Avanti");
    await o.click("Collega");
    expect(o.server.link()?.vaultId).toBe("v-work");
  });

  it("a failed link shows an error instead of doing nothing", async () => {
    const o = open("join", {}, 0);
    await toVaults(o);
    (o.root.querySelector('input[type="radio"][value="v-work"]') as HTMLInputElement).click();
    await o.click("Avanti");
    vi.spyOn(o.server, "linkDevice").mockRejectedValueOnce(new Error("boom"));
    await o.click("Collega");
    expect(o.root.textContent).toContain("Non è stato possibile completare il collegamento");
    expect(o.server.link()).toBeNull();
  });

  it("back returns to the previous step", async () => {
    const o = open("join");
    await toLogin(o);
    await o.click("Indietro");
    expect(o.input("Indirizzo del server")).not.toBeNull();
  });
});
