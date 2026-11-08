import { createDiffView, type DiffViewHandle } from "@kamino/ui-diff";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

export interface DiffViewApi {
  /** Your version with the edits; null if the view is not mounted (never save an empty merge). */
  getMerged(): string | null;
}

/** React adapter for @kamino/ui-diff (CodeMirror merge). Destroyed on unmount or input change. */
export function DiffView({
  mine,
  incoming,
  layout,
  editable,
  labels,
  phrases,
  ref,
}: {
  mine: string;
  incoming: string;
  layout: "split" | "unified";
  editable: boolean;
  labels: { mine: string; incoming: string };
  phrases?: Record<string, string>;
  ref?: Ref<DiffViewApi>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<DiffViewHandle | null>(null);
  const phrasesKey = JSON.stringify(phrases ?? {});
  useEffect(() => {
    if (!host.current) return;
    const h = createDiffView(host.current, {
      mine,
      incoming,
      layout,
      editable,
      labels,
      ...(phrases ? { phrases } : {}),
    });
    handle.current = h;
    return () => {
      h.destroy();
      handle.current = null;
    };
    // labels/phrases compared by value
  }, [mine, incoming, layout, editable, labels.mine, labels.incoming, phrasesKey]);
  useImperativeHandle(ref, () => ({ getMerged: () => handle.current?.getMerged() ?? null }), []);
  return <div ref={host} className="kamino-diff overflow-hidden rounded-lg border" />;
}
