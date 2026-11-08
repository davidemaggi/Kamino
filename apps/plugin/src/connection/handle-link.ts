import { Notice } from "obsidian";
import { t } from "../i18n/index.js";
import type { UiContext } from "../ui/context.js";
import { parsePairingLink } from "./link.js";

/** obsidian://<action>?server=…&token=… → claim flow (spec §3.4). Never throws. */
export function handlePairingLink(params: Record<string, string>, ctx: UiContext): void {
  const m = t(ctx.lang);
  const parsed = parsePairingLink(params);
  if (!parsed.ok) {
    new Notice(m.pairing.invalidLink);
    return;
  }
  if (ctx.connection.link()) {
    void ctx.confirm({
      title: m.pairing.alreadyLinkedTitle,
      text: m.pairing.alreadyLinked,
      confirmText: null,
      cancelText: m.pairing.close,
    });
    return;
  }
  if (ctx.isMobile && parsed.link.server.startsWith("http:")) {
    new Notice(m.connect.errors.insecure_on_mobile);
    return;
  }
  ctx.openClaim(parsed.link);
}
