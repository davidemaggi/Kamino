import { PROTOCOL_ACTION } from "@kamino/brand";
import { DEFAULT_THRESHOLDS, describeStatus } from "@kamino/status";
import { getIconIds, Platform, Plugin } from "obsidian";
import { APP_VERSION } from "./build-info.js";
import { FakeServer } from "./connection/fake-server.js";
import { handlePairingLink } from "./connection/handle-link.js";
import { watchPairingEvents } from "./connection/pairing-notices.js";
import { registerDevCommands } from "./dev/commands.js";
import { detectLanguage, t } from "./i18n/index.js";
import { SettingsStore } from "./settings/store.js";
import { SettingsTab } from "./settings/SettingsTab.js";
import { FakeSyncState } from "./state/fake.js";
import { AddDeviceModal } from "./ui/AddDeviceModal.js";
import { BulkResolveModal } from "./ui/BulkResolveModal.js";
import { ConnectModal } from "./ui/ConnectModal.js";
import { confirmDialog } from "./ui/ConfirmModal.js";
import { ConflictView } from "./ui/ConflictView.js";
import type { UiContext } from "./ui/context.js";
import { PairingClaimModal } from "./ui/PairingClaimModal.js";
import { StatusIndicator } from "./ui/StatusIndicator.js";
import { StatusPanelView } from "./ui/StatusPanelView.js";
import { TransferView } from "./ui/TransferView.js";
import { WelcomeView } from "./ui/WelcomeView.js";
import {
  CONFLICT_VIEW,
  openConflict,
  openStatusPanel,
  openTransfer,
  openWelcome,
  STATUS_VIEW,
  TRANSFER_VIEW,
  WELCOME_VIEW,
} from "./ui/workspace.js";

function platformLabel(): string {
  if (Platform.isIosApp) return "iPhone";
  if (Platform.isAndroidApp) return "Android";
  if (Platform.isMacOS) return "macOS";
  if (Platform.isWin) return "Windows";
  if (Platform.isLinux) return "Linux";
  return "Obsidian";
}

export default class SyncPlugin extends Plugin {
  override async onload(): Promise<void> {
    const lang = detectLanguage();
    const m = t(lang);
    const now = () => Date.now();
    const isMobile = Platform.isMobile;

    const settings = new SettingsStore(this, isMobile);
    await settings.load();
    const server = new FakeServer({
      isMobile,
      clock: now,
      delay: (ms) => new Promise((r) => window.setTimeout(r, ms)),
      random: Math.random,
      localFileCount: () => this.app.vault.getFiles().length,
      pluginVersion: APP_VERSION,
      platform: platformLabel(),
      store: settings.linkStore,
      autoRun: true,
    });
    const state = new FakeSyncState(
      {
        name: server.link()?.deviceName ?? m.panel.notLinked,
        mode: "live",
        server: server.link()?.host ?? m.panel.noServer,
      },
      now,
    );
    state.setLinked(server.link() !== null);

    const ctx: UiContext = {
      source: state,
      actions: state,
      connection: server,
      transfer: server.transfer,
      settings,
      engineAvailable: false,
      lang,
      isMobile,
      isIos: Platform.isIosApp,
      platformLabel: platformLabel(),
      vaultName: this.app.vault.getName(),
      configDir: this.app.vault.configDir,
      now,
      available: new Set(getIconIds()),
      localFileCount: () => this.app.vault.getFiles().length,
      openStatusPanel: () => openStatusPanel(this.app),
      openConflict: (id) => openConflict(this.app, id),
      openBulkResolve: () => new BulkResolveModal(this.app, ctx).open(),
      openWelcome: () => openWelcome(this.app),
      openTransfer: () => openTransfer(this.app),
      openConnect: (mode) => new ConnectModal(this.app, ctx, mode).open(),
      openClaim: (link) => new PairingClaimModal(this.app, ctx, link).open(),
      openAddDevice: (request) => new AddDeviceModal(this.app, ctx, request).open(),
      confirm: (opts) => confirmDialog(this.app, opts),
    };

    this.addSettingTab(new SettingsTab(this.app, this, ctx));
    this.registerView(STATUS_VIEW, (leaf) => new StatusPanelView(leaf, ctx));
    this.registerView(CONFLICT_VIEW, (leaf) => new ConflictView(leaf, ctx));
    this.registerView(WELCOME_VIEW, (leaf) => new WelcomeView(leaf, ctx));
    this.registerView(TRANSFER_VIEW, (leaf) => new TransferView(leaf, ctx));

    const indicator = new StatusIndicator(this, {
      isMobile,
      lang,
      now,
      available: ctx.available,
      onOpenDetails: () => void ctx.openStatusPanel(),
    });
    indicator.mount();
    const refresh = () =>
      indicator.update(describeStatus(state.snapshot(), DEFAULT_THRESHOLDS, now()));
    this.register(state.onChange(refresh));
    const deviceInfo = () => {
      const link = server.link();
      return {
        name: link?.deviceName ?? m.panel.notLinked,
        mode: "live" as const,
        server: link?.host ?? m.panel.noServer,
      };
    };
    this.register(
      server.onChange((e) => {
        if (e.type === "linked" || e.type === "unlinked") state.setLinked(e.type === "linked");
        if (e.type === "linked" || e.type === "unlinked" || e.type === "device_renamed")
          state.setDevice(deviceInfo());
      }),
    );
    this.register(server.transfer.onChange(() => state.setTransfer(server.transfer.progress())));
    refresh();

    this.addCommand({
      id: "open-status",
      name: m.panel.openCommand,
      callback: () => void ctx.openStatusPanel(),
    });
    this.addCommand({
      id: "connect",
      name: m.commands.connect,
      callback: () => void ctx.openWelcome(),
    });

    // Pairing link (QR / magic link): obsidian://<action>?server=…&token=…
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) =>
      handlePairingLink(params, ctx),
    );
    this.register(watchPairingEvents(ctx));
    this.addCommand({
      id: "add-device",
      name: m.commands.addDevice,
      checkCallback: (checking) => {
        if (!server.link()) return false;
        if (!checking) ctx.openAddDevice();
        return true;
      },
    });

    this.app.workspace.onLayoutReady(() => {
      if (!server.link()) void ctx.openWelcome();
    });

    if (__DEV__) registerDevCommands(this, { lang, now, state, ctx, server });
  }
}
