import { PROTOCOL_ACTION } from "@kamino/brand";
import { DEFAULT_THRESHOLDS, describeStatus } from "@kamino/status";
import { getIconIds, Notice, Platform, Plugin } from "obsidian";
import { parsePairingLink } from "./connection/link.js";
import { registerDevCommands } from "./dev/commands.js";
import { fmt } from "./i18n/format.js";
import { detectLanguage, t } from "./i18n/index.js";
import { SettingsTab } from "./settings/SettingsTab.js";
import { FakeSyncState } from "./state/fake.js";
import type { UiContext } from "./ui/context.js";
import { StatusIndicator } from "./ui/StatusIndicator.js";
import { BulkResolveModal } from "./ui/BulkResolveModal.js";
import { ConflictView } from "./ui/ConflictView.js";
import { StatusPanelView } from "./ui/StatusPanelView.js";
import { CONFLICT_VIEW, openConflict, openStatusPanel, STATUS_VIEW } from "./ui/workspace.js";

export default class SyncPlugin extends Plugin {
  override onload(): void {
    this.addSettingTab(new SettingsTab(this.app, this));

    const lang = detectLanguage();
    const m = t(lang);
    const now = () => Date.now();
    // Until the sync engine lands (M1/M3) the state is an empty in-memory one: "never synced".
    const state = new FakeSyncState(
      { name: m.panel.notLinked, mode: "live", server: m.panel.noServer },
      now,
    );
    const ctx: UiContext = {
      source: state,
      actions: state,
      lang,
      isMobile: Platform.isMobile,
      now,
      available: new Set(getIconIds()),
      openStatusPanel: () => openStatusPanel(this.app),
      openConflict: (id) => openConflict(this.app, id),
      openBulkResolve: () => new BulkResolveModal(this.app, ctx).open(),
    };

    this.registerView(STATUS_VIEW, (leaf) => new StatusPanelView(leaf, ctx));
    this.registerView(CONFLICT_VIEW, (leaf) => new ConflictView(leaf, ctx));

    const indicator = new StatusIndicator(this, {
      isMobile: ctx.isMobile,
      lang,
      now,
      available: ctx.available,
      onOpenDetails: () => void ctx.openStatusPanel(),
    });
    indicator.mount();
    const refresh = () =>
      indicator.update(describeStatus(state.snapshot(), DEFAULT_THRESHOLDS, now()));
    this.register(state.onChange(refresh));
    refresh();

    this.addCommand({
      id: "open-status",
      name: m.panel.openCommand,
      callback: () => void ctx.openStatusPanel(),
    });

    // Pairing link handler. Until the claim flow lands (task 7) it only validates and reports.
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
      const parsed = parsePairingLink(params);
      new Notice(
        parsed.ok
          ? fmt(m.pairing.linkReceived, { host: new URL(parsed.link.server).host })
          : m.pairing.invalidLink,
      );
    });

    if (__DEV__) registerDevCommands(this, { lang, now, state, ctx });
  }
}
