import { PLUGIN_ID, PROTOCOL_ACTION } from "@kamino/brand";
import type { DevicePlatform } from "@kamino/protocol";
import { DEFAULT_THRESHOLDS, describeStatus } from "@kamino/status";
import { getIconIds, Notice, Platform, Plugin } from "obsidian";
import { APP_VERSION } from "./build-info.js";
import { FakeServer } from "./connection/fake-server.js";
import { handlePairingLink } from "./connection/handle-link.js";
import { watchPairingEvents } from "./connection/pairing-notices.js";
import { RealConnection } from "./connection/real-server.js";
import { RealTransfer } from "./connection/real-transfer.js";
import type { ConnectionService, InitialTransfer } from "./connection/types.js";
import { EngineHost, type SyncPlatform } from "./engine/host.js";
import { ObsidianFs } from "./engine/obsidian-fs.js";
import { ObsidianHttp } from "./engine/obsidian-http.js";
import { SettingsSync } from "./engine/settings-sync.js";
import { registerDevCommands } from "./dev/commands.js";
import { detectLanguage, t } from "./i18n/index.js";
import { SettingsStore } from "./settings/store.js";
import { SettingsTab } from "./settings/SettingsTab.js";
import { EngineState } from "./state/engine-state.js";
import { InsistentNotices } from "./state/insistent-notices.js";
import { FakeSyncState } from "./state/fake.js";
import type { ConflictActions, SyncStateSource } from "./state/types.js";
import { Watcher } from "./engine/watcher.js";
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

/** The platform as the server and sync-core name it. */
function devicePlatform(): DevicePlatform & SyncPlatform {
  if (Platform.isIosApp) return "ios";
  if (Platform.isAndroidApp) return "android";
  if (Platform.isMacOS) return "macos";
  if (Platform.isWin) return "windows";
  return "linux";
}

export default class SyncPlugin extends Plugin {
  private host: EngineHost | null = null;

  override onunload(): void {
    void this.host?.stop();
  }

  override async onload(): Promise<void> {
    const lang = detectLanguage();
    const m = t(lang);
    const now = () => Date.now();
    const isMobile = Platform.isMobile;

    const settings = new SettingsStore(this, isMobile);
    await settings.load();
    // The fake server only in development builds (E1), unless the developer asks for the real one.
    // `__DEV__` is a build constant: in production esbuild drops this branch and the fake with it.
    let server: ConnectionService;
    let transfer: InitialTransfer;
    let fake: FakeServer | null = null;
    if (__DEV__ && window.localStorage.getItem(`${PLUGIN_ID}-dev-real-server`) !== "1") {
      fake = new FakeServer({
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
      server = fake;
      transfer = fake.transfer;
    } else {
      const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${PLUGIN_ID}`;
      const real = new RealConnection({
        isMobile,
        store: settings.linkStore,
        pluginVersion: APP_VERSION,
        platform: devicePlatform(),
        http: (url) => new ObsidianHttp(url),
      });
      const settingsSync = new SettingsSync({
        local: () => settings.get(),
        notice: (msg) => new Notice(msg),
        reloadText: m.settings.reloadToApply,
      });
      const host = new EngineHost({
        current: () => {
          const link = real.link();
          const cred = real.credentials();
          return link && cred ? { server: link.server, vaultId: link.vaultId, ...cred } : null;
        },
        fs: (deviceId) =>
          new ObsidianFs(this.app, pluginDir, { stateDir: `${pluginDir}/state/${deviceId}` }),
        http: (url) => new ObsidianHttp(url),
        platform: devicePlatform(),
        configDir: this.app.vault.configDir,
        clock: {
          now,
          sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)),
          random: Math.random,
        },
        newId: () => crypto.randomUUID(),
        loadSettings: (api, fs) => settingsSync.load(api, fs),
      });
      this.host = host;
      this.register(settings.onChange(() => void host.reloadSettings()));
      this.register(real.onChange(() => void host.refresh()));
      void host.refresh();
      server = real;
      transfer = new RealTransfer(() => host.engine());
      // Vault events → debounced cycles (E4).
      this.register(
        new Watcher(this.app, () => host.engine()).attach((ref) => this.registerEvent(ref)),
      );
    }
    const deviceInfo = () => {
      const link = server.link();
      return {
        name: link?.deviceName ?? m.panel.notLinked,
        mode: "live" as const,
        server: link?.host ?? m.panel.noServer,
      };
    };
    const useFake = fake !== null;
    const fakeState = __DEV__ && useFake ? new FakeSyncState(deviceInfo(), now) : null;
    fakeState?.setLinked(server.link() !== null);
    const host = this.host;
    const state: SyncStateSource & ConflictActions =
      fakeState ??
      new EngineState({
        engine: () => host?.engine() ?? null,
        onHostChange: (cb) => host?.onChange(cb) ?? (() => {}),
        device: deviceInfo,
        notice: (msg) => new Notice(msg),
        comingSoon: m.conflict.comingSoon,
      });

    const ctx: UiContext = {
      source: state,
      actions: state,
      connection: server,
      transfer,
      settings,
      engineAvailable: !useFake,
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
      openClaim: (link) => {
        if (!server.pairingAvailable) new Notice(m.pairing.comingSoon);
        else new PairingClaimModal(this.app, ctx, link).open();
      },
      openAddDevice: (request) => {
        if (!server.pairingAvailable) new Notice(m.pairing.comingSoon);
        else new AddDeviceModal(this.app, ctx, request).open();
      },
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
    // S-05: never silent; the warning comes back every hour while the problem lasts.
    this.register(
      new InsistentNotices({
        source: state,
        clock: now,
        notice: (msg) => new Notice(msg),
        lang,
      }).start(),
    );
    if (fakeState) {
      this.register(
        server.onChange((e) => {
          if (e.type === "linked" || e.type === "unlinked")
            fakeState.setLinked(e.type === "linked");
          if (e.type === "linked" || e.type === "unlinked" || e.type === "device_renamed")
            fakeState.setDevice(deviceInfo());
        }),
      );
      this.register(transfer.onChange(() => fakeState.setTransfer(transfer.progress())));
    }
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

    if (__DEV__ && fake && fakeState)
      registerDevCommands(this, { lang, now, state: fakeState, ctx, server: fake });
  }
}
