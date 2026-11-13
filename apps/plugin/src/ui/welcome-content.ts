import { PRODUCT_NAME, PROTOCOL_ACTION } from "@kamino/brand";
import { parsePairingUrl } from "../connection/link.js";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "./context.js";
import { h } from "./dom.js";
import { CLASS_PREFIX } from "./status-classes.js";

const P = `${CLASS_PREFIX}-welcome`;

/**
 * The three ways in (spec §3.1), shared by the welcome tab and the welcome window. `onLeave` runs
 * before a choice hands over to another window (the window closes itself there).
 */
export function renderWelcome(root: HTMLElement, ctx: UiContext, onLeave: () => void): void {
  let showLinkHelp = false;
  let linkError = false;
  const render = () => {
    const m = t(ctx.lang).welcome;
    root.replaceChildren();
    root.classList.add(P);
    h(root, "h2", { text: fmt(m.title, { product: PRODUCT_NAME }) });
    h(root, "p", { cls: `${P}__muted`, text: m.intro });

    const choice = (title: string, desc: string, onClick: () => void) => {
      const b = h(root, "button", { cls: `${P}__choice` });
      h(b, "b", { text: title });
      h(b, "span", { cls: `${P}__muted`, text: desc });
      b.addEventListener("click", onClick);
    };
    choice(m.createTitle, m.createDesc, () => {
      onLeave();
      ctx.openConnect("create");
    });
    choice(m.joinTitle, m.joinDesc, () => {
      onLeave();
      ctx.openConnect("join");
    });
    choice(m.linkTitle, m.linkDesc, () => {
      showLinkHelp = true;
      render();
    });

    if (!showLinkHelp) return;
    const help = h(root, "section", { cls: `${P}__help` });
    if (ctx.isMobile) {
      h(help, "p", { text: m.linkHowMobile });
      return;
    }
    h(help, "p", { text: m.linkHowDesktop });
    const input = h(help, "input", {
      attrs: { type: "text", "aria-label": m.linkPaste, placeholder: m.linkPaste },
    });
    h(help, "button", { cls: "mod-cta", text: m.linkGo }).addEventListener("click", () => {
      const parsed = parsePairingUrl(input.value, PROTOCOL_ACTION);
      if (!parsed.ok) {
        linkError = true;
        error.textContent = m.linkInvalid;
        return;
      }
      linkError = false;
      error.textContent = "";
      onLeave();
      ctx.openClaim(parsed.link);
    });
    const error = h(help, "p", {
      cls: `${P}__error`,
      attrs: { role: "alert" },
      text: linkError ? m.linkInvalid : "",
    });
  };
  render();
}
