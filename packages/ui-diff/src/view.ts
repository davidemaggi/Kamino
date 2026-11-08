import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface DiffViewOptions {
  mine: string;
  incoming: string;
  layout: "split" | "unified";
  editable: boolean;
  /** Already translated. */
  labels: { mine: string; incoming: string };
  /** CodeMirror phrases (e.g. merge control labels), already translated. */
  phrases?: Record<string, string>;
}

export interface DiffViewHandle {
  /** Your version, with the edits made in the view. */
  getMerged(): string;
  destroy(): void;
}

const READ_ONLY: Extension[] = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

function common(label: string, phrases: Record<string, string> | undefined): Extension[] {
  return [
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ "aria-label": label }),
    ...(phrases ? [EditorState.phrases.of(phrases)] : []),
  ];
}

/**
 * Diff/merge view on @codemirror/merge. In both layouts the editable document is
 * "mine", so a merge always starts from your version.
 */
export function createDiffView(parent: HTMLElement, opts: DiffViewOptions): DiffViewHandle {
  const wrapper = parent.ownerDocument.createElement("div");
  wrapper.className = `diff-view diff-view--${opts.layout}`;
  parent.append(wrapper);

  if (opts.layout === "split") {
    const view = new MergeView({
      a: {
        doc: opts.mine,
        extensions: [
          ...common(opts.labels.mine, opts.phrases),
          ...(opts.editable ? [] : READ_ONLY),
        ],
      },
      b: {
        doc: opts.incoming,
        extensions: [...common(opts.labels.incoming, opts.phrases), ...READ_ONLY],
      },
      parent: wrapper,
      highlightChanges: true,
      gutter: true,
      ...(opts.editable ? { revertControls: "b-to-a" as const } : {}),
    });
    return {
      getMerged: () => view.a.state.doc.toString(),
      destroy: () => {
        view.destroy();
        wrapper.remove();
      },
    };
  }

  const view = new EditorView({
    parent: wrapper,
    state: EditorState.create({
      doc: opts.mine,
      extensions: [
        ...common(`${opts.labels.mine} / ${opts.labels.incoming}`, opts.phrases),
        ...(opts.editable ? [] : READ_ONLY),
        unifiedMergeView({
          original: opts.incoming,
          mergeControls: opts.editable,
          highlightChanges: true,
          gutter: true,
        }),
      ],
    }),
  });
  return {
    getMerged: () => view.state.doc.toString(),
    destroy: () => {
      view.destroy();
      wrapper.remove();
    },
  };
}
