import { describe, expect, it } from "vitest";
import { App } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import type { UiContext } from "../ui/context.js";
import { SettingsTab } from "./SettingsTab.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

async function open(over: Partial<UiContext> = {}, linked = false) {
  const made = makeCtx(over);
  if (linked) {
    const login = await made.server.login("http://10.0.0.2:8080", "demo", "demo");
    if (!login.ok) throw new Error("login");
    await made.server.linkDevice(login.session, "v-notes", "Laptop");
  }
  const tab = new SettingsTab(new App() as never, made.plugin as never, made.ctx);
  tab.display();
  const root = (tab as unknown as { containerEl: HTMLElement }).containerEl;
  const names = () => [...root.querySelectorAll(".setting-item-name")].map((x) => x.textContent);
  const row = (name: string) =>
    [...root.querySelectorAll(".setting-item")].find(
      (x) => x.querySelector(".setting-item-name")?.textContent === name,
    )!;
  return { ...made, tab, root, names, row };
}

describe("SettingsTab", () => {
  it("not linked: link section offers 'Collega…'", async () => {
    const { names, row, ctx } = await open();
    expect(names()).toContain("Questo vault non è collegato.");
    (row("Questo vault non è collegato.").querySelector("button") as HTMLButtonElement).click();
    expect(ctx.openWelcome).toHaveBeenCalled();
    expect(names()).not.toContain("Scollega questo vault");
  });

  it("linked: server, user, vault, device name, add device, unlink and http warning", async () => {
    const { names, root } = await open({}, true);
    for (const n of [
      "Server",
      "Utente",
      "Vault",
      "Nome di questo dispositivo",
      "Aggiungi un dispositivo",
      "Scollega questo vault",
    ]) {
      expect(names()).toContain(n);
    }
    expect(root.textContent).toContain("Connessione non cifrata.");
  });

  it("unlink asks for confirmation", async () => {
    const { row, ctx, server } = await open({}, true);
    (ctx.confirm as unknown as { mockResolvedValueOnce(v: boolean): void }).mockResolvedValueOnce(
      false,
    );
    (row("Scollega questo vault").querySelector("button") as HTMLButtonElement).click();
    await flush();
    expect(ctx.confirm).toHaveBeenCalledWith(expect.objectContaining({ warning: true }));
    expect(server.link()).not.toBeNull();
    (row("Scollega questo vault").querySelector("button") as HTMLButtonElement).click();
    await flush();
    expect(server.link()).toBeNull();
  });

  it("shows the not-yet-active note and mode-dependent rows", async () => {
    const { root, names, row, store } = await open();
    expect(root.textContent).toContain(
      "Queste impostazioni verranno usate quando il sync sarà attivo.",
    );
    expect(names()).toContain("Pausa di scrittura per le note aperte");
    const select = row("Modalità").querySelector("select") as HTMLSelectElement;
    select.value = "periodic";
    select.dispatchEvent(new Event("change"));
    await flush();
    expect(store.get().sync.mode).toBe("periodic");
    expect(names()).toContain("Ogni quanti minuti");
    expect(names()).not.toContain("Pausa di scrittura per le note aperte");
  });

  it("numbers are clamped", async () => {
    const { row, store } = await open();
    const input = row("Pausa di scrittura per le note aperte").querySelector(
      "input",
    ) as HTMLInputElement;
    input.value = "99";
    input.dispatchEvent(new Event("input"));
    await flush();
    expect(store.get().sync.liveDebounceSec).toBe(30);
  });

  it("invalid globs are reported and ignored", async () => {
    const { root, store } = await open();
    const area = root.querySelector("textarea") as HTMLTextAreaElement;
    area.value = "Archivio/**\n[bad\n";
    area.dispatchEvent(new Event("input"));
    await flush();
    expect(store.get().exclusions).toEqual(["Archivio/**"]);
    expect(root.textContent).toContain("Pattern non validi, ignorati: [bad");
  });

  it("iOS note only on iOS; config categories only without vault default", async () => {
    const a = await open({ isIos: true });
    expect(a.root.textContent).toContain("Su iPhone e iPad");
    const b = await open();
    expect(b.root.textContent).not.toContain("Su iPhone e iPad");
    expect(b.names()).not.toContain("Scorciatoie");
    const toggle = b
      .row("Usa le impostazioni del vault")
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await flush();
    expect(b.names()).toContain("Scorciatoie");
  });

  it("about shows version, release and protocol", async () => {
    const { names } = await open();
    expect(names()).toEqual(
      expect.arrayContaining(["Versione", "Rilascio", "Versione del protocollo"]),
    );
  });

  it("about offers to copy the diagnostics, and says what they hold", async () => {
    const { row, ctx } = await open();
    const r = row("Diagnostica");
    expect(r.textContent).toContain("nessun nome di file");
    (r.querySelector("button") as HTMLButtonElement).click();
    expect(ctx.copyDiagnostics).toHaveBeenCalled();
  });
});
