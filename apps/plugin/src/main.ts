import { PLUGIN_ID, PRODUCT_NAME, PROTOCOL_ACTION } from "@kamino/brand";
import { PROTOCOL_VERSION, type DevicePlatform } from "@kamino/protocol";
import { DEFAULT_THRESHOLDS, describeStatus } from "@kamino/status";
import { addIcon, apiVersion, getIconIds, Notice, Platform, Plugin } from "obsidian";
import { BRAND_ICON, BRAND_ICON_SVG } from "./ui/brand-icon.js";
import { ConfigReloadPrompt } from "./ui/config-reload.js";
import { APP_CODENAME, APP_VERSION } from "./build-info.js";
import { loadText, saveText } from "./diagnostics/file.js";
import { DiagnosticLog } from "./diagnostics/log.js";
import { FakeServer } from "./connection/fake-server.js";
import { handlePairingLink } from "./connection/handle-link.js";
import { watchPairingEvents } from "./connection/pairing-notices.js";
import { RealConnection } from "./connection/real-server.js";
import { RealTransfer } from "./connection/real-transfer.js";
import type { ConnectionService, InitialTransfer } from "./connection/types.js";
import { EngineHost, type SyncPlatform } from "./engine/host.js";
import { ForceSyncModal } from "./ui/ForceSyncModal.js";
import { ObsidianFs } from "./engine/obsidian-fs.js";
import { ObsidianHttp } from "./engine/obsidian-http.js";
import { ObsidianNetwork } from "./engine/obsidian-network.js";
import { obsidianSocket } from "./engine/obsidian-socket.js";
import { askMetered } from "./ui/MeteredModal.js";
import { SettingsSync } from "./engine/settings-sync.js";
import { registerDevCommands } from "./dev/commands.js";
import { detectLanguage, t } from "./i18n/index.js";
import { SettingsStore } from "./settings/store.js";
import { SettingsTab } from "./settings/SettingsTab.js";
import { CONFLICT_COPY_LABEL } from "@kamino/sync-engine";
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
import { WelcomeModal } from "./ui/WelcomeModal.js";
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
  private diag: DiagnosticLog | null = null;
  /** M8: a reload waits for the previous engine to stop writing its state. */
  private static stopping: Promise<void> | null = null;

  override onunload(): void {
    this.diag?.add("plugin_stop");
    const flushed = this.diag?.flush();
    SyncPlugin.stopping = Promise.all([this.host?.stop(), flushed]).then(() => {});
  }

  override async onload(): Promise<void> {
    await SyncPlugin.stopping?.catch(() => {});
    SyncPlugin.stopping = null;
    const lang = detectLanguage();
    const m = t(lang);
    const now = () => Date.now();
    const isMobile = Platform.isMobile;

    // rc1: codes-only diagnostic log in the plugin folder, for support requests.
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${PLUGIN_ID}`;
    const adapter = this.app.vault.adapter;
    const diagFile = `${pluginDir}/diagnostics.log`;
    const diag = new DiagnosticLog({
      now,
      save: (text) => saveText(adapter, diagFile, text),
      schedule: (fn) => {
        const id = window.setTimeout(fn, 5000);
        return () => window.clearTimeout(id);
      },
    });
    this.diag = diag;
    diag.restore(await loadText(adapter, diagFile).catch(() => ""));
    diag.add(`plugin_start_${APP_VERSION}_${devicePlatform()}`);

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
      const real = new RealConnection({
        isMobile,
        store: settings.linkStore,
        pluginVersion: APP_VERSION,
        platform: devicePlatform(),
        http: (url) => new ObsidianHttp(url, { mobile: isMobile }),
      });
      const settingsSync = new SettingsSync({
        local: () => settings.get(),
        notice: (msg) => new Notice(msg),
        reloadText: m.settings.reloadToApply,
      });
      // S-12: Obsidian's own reload command (desktop and mobile).
      const configReload = new ConfigReloadPrompt(m.configReload, () => {
        const commands = (
          this.app as unknown as { commands?: { executeCommandById(id: string): boolean } }
        ).commands;
        if (!commands?.executeCommandById("app:reload")) window.location.reload();
      });
      const host = new EngineHost({
        current: () => {
          const link = real.link();
          const cred = real.credentials();
          return link && cred ? { server: link.server, vaultId: link.vaultId, ...cred } : null;
        },
        fs: (deviceId) =>
          new ObsidianFs(this.app, pluginDir, { stateDir: `${pluginDir}/state/${deviceId}` }),
        http: (url) => new ObsidianHttp(url, { mobile: isMobile }),
        platform: devicePlatform(),
        configDir: this.app.vault.configDir,
        clock: {
          now,
          sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)),
          random: Math.random,
        },
        newId: () => crypto.randomUUID(),
        loadSettings: (api, fs) => settingsSync.load(api, fs),
        // M2b: realtime doorbell, network, Wi-Fi option and mode (S-02, S-08).
        socket: (url) => obsidianSocket(url, { mobile: isMobile }),
        client: { pluginVersion: APP_VERSION, platform: devicePlatform() },
        network: new ObsidianNetwork({
          isMobile,
          isIos: Platform.isIosApp,
          connection: () =>
            (navigator as unknown as { connection?: { type?: string; saveData?: boolean } })
              .connection,
          confirm: () => askMetered(this.app, lang),
        }),
        wifiOnly: () => {
          const s = settings.get().largeFiles;
          return { enabled: s.wifiOnly, thresholdBytes: s.thresholdMb * 1024 * 1024 };
        },
        mode: () => {
          const s = settings.get().sync;
          return { mode: s.mode, periodicMinutes: s.periodicMinutes };
        },
        onPairing: (msg) => real.receive(msg),
        onConfigApplied: () => configReload.configApplied(),
        log: (code) => diag.add(code),
      });
      this.host = host;
      this.addCommand({
        id: "force-sync",
        name: m.commands.forceSync,
        checkCallback: (checking) => {
          const engine = host.engine();
          if (!engine) return false;
          if (!checking)
            new ForceSyncModal(this.app, lang, {
              devices: () => host.otherDevices(),
              request: async (targets) => void (await engine.forceSyncFrom(targets)),
            }).open();
          return true;
        },
      });
      this.register(
        settings.onChange(() => {
          // M10: the device's choice applies at once, the server confirms it.
          const quick = settingsSync.quick();
          if (quick) host.engine()?.setSettings(quick);
          const s = settings.get().sync;
          host.engine()?.setMode(s.mode, s.periodicMinutes);
          void host.reloadSettings();
        }),
      );
      this.register(real.onChange(() => void host.refresh()));
      this.register(() => real.dispose());
      void host.refresh();
      server = real;
      transfer = new RealTransfer(() => host.engine());
      // Vault events → debounced cycles (E4).
      this.register(
        new Watcher(
          this.app,
          () => host.engine(),
          () => settings.get().sync.liveDebounceSec * 1000,
        ).attach((ref) => this.registerEvent(ref)),
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
        labels: {
          copy: CONFLICT_COPY_LABEL[lang],
          webApp: m.conflict.webApp,
          otherDevice: m.conflict.otherDevice,
          failed: m.conflict.failed,
        },
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
      openLinkChoices: () => new WelcomeModal(this.app, ctx).open(),
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
      copyDiagnostics: async () => {
        const snap = state.snapshot();
        const d = describeStatus(snap, DEFAULT_THRESHOLDS, now());
        const text = diag.report({
          product: PRODUCT_NAME,
          version: APP_VERSION,
          release: APP_CODENAME,
          protocol: PROTOCOL_VERSION,
          obsidian: apiVersion,
          platform: devicePlatform(),
          mobile: isMobile,
          linked: server.link() !== null,
          mode: settings.get().sync.mode,
          status: `${d.level} ${d.message.key}`,
          queued: snap.queued,
          conflicts: snap.conflicts,
        });
        try {
          await navigator.clipboard.writeText(text);
          new Notice(m.diagnostics.copied);
        } catch {
          new Notice(m.diagnostics.copyFailed);
        }
      },
    };

    this.addSettingTab(new SettingsTab(this.app, this, ctx));
    addIcon(BRAND_ICON, BRAND_ICON_SVG);
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
    let lastStatus = "";
    const refresh = () => {
      const d = describeStatus(state.snapshot(), DEFAULT_THRESHOLDS, now());
      const status = `status_${d.level}_${d.message.key}`;
      if (status !== lastStatus) diag.add((lastStatus = status));
      indicator.update(d);
    };
    this.register(server.onChange((e) => diag.add(`connection_${e.type}`)));
    this.register(state.onChange(refresh));
    // S-05: never silent; the warning comes back every hour while the problem lasts.
    this.register(
      new InsistentNotices({
        source: state,
        clock: now,
        notice: (msg) => new Notice(msg),
        lang,
        mode: () => settings.get().sync.mode,
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
      id: "copy-diagnostics",
      name: m.commands.copyDiagnostics,
      callback: () => void ctx.copyDiagnostics(),
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
