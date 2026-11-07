// R-3: can a @codemirror/merge view run inside a plugin Modal, sharing
// Obsidian's own @codemirror/state + @codemirror/view (variant "external"),
// or only with its own bundled copy (variant "bundled")?
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Modal, type App } from "obsidian";
import { CM_MERGE_VERSION, errorText, Report, SPIKE_VARIANT } from "./report.ts";

const LOCAL = `# Shopping list

- milk
- bread
- eggs (a dozen)

Notes written on the phone while offline.
This line only exists locally.
`;

const REMOTE = `# Shopping list

- milk
- wholegrain bread
- eggs

Notes written on the phone while offline.
This line was added on the desktop.
`;

type Mode = "side-by-side" | "unified";

class MergeModal extends Modal {
  #destroy: (() => void) | null = null;

  constructor(
    app: App,
    private readonly report: Report,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(
      `Merge view spike (${SPIKE_VARIANT}, @codemirror/merge ${CM_MERGE_VERSION})`,
    );
    const bar = this.contentEl.createDiv({ cls: "kamino-spike-bar" });
    const host = this.contentEl.createDiv({ cls: "kamino-spike-merge" });
    const status = this.contentEl.createDiv({ cls: "kamino-spike-status" });
    const show = (mode: Mode) => {
      this.#destroy?.();
      this.#destroy = null;
      host.empty();
      try {
        this.#destroy = mode === "side-by-side" ? sideBySide(host) : unified(host);
        status.setText(
          `${mode}: constructed OK. Check highlighting, scrolling, editing, revert arrows.`,
        );
        void this.report.line(`- ${mode}: constructed OK`);
      } catch (err) {
        status.setText(`${mode}: FAILED ${errorText(err)}`);
        void this.report.line(`- ${mode}: FAILED ${errorText(err)}`);
        console.error(err);
      }
    };
    bar.createEl("button", { text: "Side by side" }).onclick = () => show("side-by-side");
    bar.createEl("button", { text: "Unified" }).onclick = () => show("unified");
    show(window.innerWidth < 700 ? "unified" : "side-by-side");
  }

  override onClose(): void {
    this.#destroy?.();
    this.contentEl.empty();
    void this.report.done();
  }
}

function sideBySide(parent: HTMLElement): () => void {
  const view = new MergeView({
    a: { doc: LOCAL, extensions: [EditorView.lineWrapping] },
    b: { doc: REMOTE, extensions: [EditorView.lineWrapping, EditorState.readOnly.of(true)] },
    parent,
    revertControls: "b-to-a",
    highlightChanges: true,
    gutter: true,
  });
  return () => view.destroy();
}

function unified(parent: HTMLElement): () => void {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: LOCAL,
      extensions: [
        EditorView.lineWrapping,
        unifiedMergeView({ original: REMOTE, mergeControls: true }),
      ],
    }),
  });
  return () => view.destroy();
}

export async function openMergeSpike(app: App, device: string): Promise<void> {
  const report = await Report.create(app, "R-3", device, "merge view in a modal");
  await report.line(
    `- variant: ${SPIKE_VARIANT} (external = Obsidian's @codemirror/state+view; bundled = own copy)`,
  );
  await report.line(`- @codemirror/merge: ${CM_MERGE_VERSION}`);
  await report.line(`- isMobile layout: window ${window.innerWidth}x${window.innerHeight}`);
  new MergeModal(app, report).open();
}
