import type { Lang } from "@kamino/status";
import type { Plugin } from "obsidian";
import { t } from "../i18n/index.js";
import type { FakeServer } from "../connection/fake-server.js";
import type { FakeSyncState } from "../state/fake.js";
import { conflictScenario } from "../state/scenarios.js";
import type { UiContext } from "../ui/context.js";
import { DiffTestModal } from "./diff-test.js";
import { LinkTestModal } from "./link-test.js";
import { registerStatusGallery } from "./status-gallery.js";

export interface DevDeps {
  lang: Lang;
  now: () => number;
  state: FakeSyncState;
  ctx: UiContext;
  server: FakeServer;
}

/** Registers development-only commands (called only when __DEV__). */
export function registerDevCommands(plugin: Plugin, deps: DevDeps): void {
  registerStatusGallery(plugin, deps.state, deps);
  plugin.addCommand({
    id: "dev-conflict-scenario",
    name: t(deps.lang).dev.conflictScenario,
    callback: () => {
      deps.state.loadScenario(conflictScenario(deps.now()));
      void deps.ctx.openStatusPanel();
    },
  });
  plugin.addCommand({
    id: "dev-diff-test",
    name: t(deps.lang).dev.diffTest,
    callback: () => new DiffTestModal(plugin.app, deps.lang).open(),
  });
  plugin.addCommand({
    id: "dev-link-test",
    name: t(deps.lang).dev.linkTest,
    callback: () => new LinkTestModal(plugin.app, deps.lang).open(),
  });
  const m = t(deps.lang).dev;
  const sims: Array<[string, string, () => void]> = [
    ["dev-pairing-request", m.simPairingRequest, () => deps.server.simulateIncomingClaim()],
    ["dev-claim-approve", m.simApprove, () => deps.server.simulateClaimAnswer("approved")],
    ["dev-claim-deny", m.simDeny, () => deps.server.simulateClaimAnswer("denied")],
    ["dev-device-joined", m.simDeviceJoined, () => deps.server.simulateDeviceJoined("iPad")],
    ["dev-transfer-interrupt", m.simInterrupt, () => deps.server.interruptTransfer()],
    ["dev-transfer-fail", m.simFail, () => deps.server.failTransfer()],
  ];
  for (const [id, name, callback] of sims) plugin.addCommand({ id, name, callback });
}
