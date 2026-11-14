import { Notice } from "obsidian";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import { AddDeviceModal } from "../ui/AddDeviceModal.js";
import type { UiContext } from "../ui/context.js";

/** Pairing events while no approval window shows them (spec §3.6). Returns the unsubscribe. */
export function watchPairingEvents(ctx: UiContext): () => void {
  const m = t(ctx.lang).pairing;
  return ctx.connection.onChange((e) => {
    if (e.type === "pairing_request" && !AddDeviceModal.isShowing(e.request.pairingId)) {
      const notice = new Notice(m.noticeRequest, 15_000);
      notice.messageEl.addEventListener("click", () => ctx.openAddDevice(e.request));
    } else if (e.type === "device_joined") {
      new Notice(fmt(m.noticeJoined, { name: e.deviceName }));
    } else if (e.type === "pairing_reused") {
      new Notice(m.noticeReused);
    }
  });
}
