/** Creates a child element with standard DOM (works in popout windows and in tests). */
export function h<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  opts: { cls?: string; text?: string; attrs?: Record<string, string> } = {},
): HTMLElementTagNameMap[K] {
  const el = parent.ownerDocument.createElement(tag);
  if (opts.cls) el.className = opts.cls;
  if (opts.text !== undefined) el.textContent = opts.text;
  for (const [k, v] of Object.entries(opts.attrs ?? {})) el.setAttribute(k, v);
  parent.append(el);
  return el;
}
