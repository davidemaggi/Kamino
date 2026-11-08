import { describe, expect, it } from "vitest";
import { WorkspaceLeaf } from "../__mocks__/obsidian.js";
import { makeCtx } from "../__mocks__/ui-context.js";
import { TransferView } from "./TransferView.js";
import { TRANSFER_VIEW } from "./workspace.js";

async function open() {
  const made = makeCtx();
  made.plugin.app.vault.files = Array.from({ length: 10 }, (_, i) => ({ path: `n${i}.md` }));
  made.plugin.registerView(
    TRANSFER_VIEW,
    (leaf) => new TransferView(leaf as never, made.ctx) as never,
  );
  const leaf = new WorkspaceLeaf(made.plugin.app);
  await leaf.setViewState({ type: TRANSFER_VIEW });
  const root = leaf.view!.contentEl;
  const button = (text: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent === text);
  return { ...made, root, button };
}

describe("TransferView", () => {
  it("nothing to show without a transfer", async () => {
    const { root } = await open();
    expect(root.textContent).toContain("Nessun trasferimento in corso.");
  });

  it("progress, pause, resume, done", async () => {
    const { root, server, button, ctx } = await open();
    server.transfer.start("upload");
    server.advance(4);
    expect(root.querySelector("h2")?.textContent).toBe("Caricamento iniziale");
    expect((root.querySelector("progress") as HTMLProgressElement).value).toBe(4);
    expect(root.textContent).toContain("4 di 10 file");
    button("Pausa")!.click();
    expect(root.textContent).toContain("In pausa.");
    button("Riprendi")!.click();
    server.advance(10);
    expect(root.textContent).toContain("Fatto: 10 file sincronizzati.");
    button("Apri lo stato sync")!.click();
    expect(ctx.openStatusPanel).toHaveBeenCalled();
  });

  it("interruption and failure with retry", async () => {
    const { root, server, button } = await open();
    server.transfer.start("download");
    server.interruptTransfer();
    expect(root.textContent).toContain("Interrotto: riprendo appena possibile.");
    server.failTransfer();
    expect(root.textContent).toContain("Il trasferimento si è fermato per un errore.");
    button("Riprova")!.click();
    expect(server.transfer.progress()?.phase).toBe("running");
  });
});
