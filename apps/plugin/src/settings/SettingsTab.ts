import { PROTOCOL_VERSION } from "@kamino/protocol";
import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import { APP_CODENAME, APP_VERSION } from "../build-info.js";
import { fmt } from "../i18n/format.js";
import { t } from "../i18n/index.js";
import type { UiContext } from "../ui/context.js";
import { CLASS_PREFIX } from "../ui/status-classes.js";
import { CONFIG_CATEGORIES, validateGlob, type SyncMode } from "./model.js";

const P = `${CLASS_PREFIX}-settings`;

/** Full plugin settings (spec §6). Every change is saved right away, normalized. */
export class SettingsTab extends PluginSettingTab {
  private invalidGlobs: string[] = [];

  constructor(
    app: App,
    plugin: Plugin,
    private readonly ctx: UiContext,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl, ctx } = this;
    const m = t(ctx.lang).settings;
    const s = ctx.settings.get();
    const link = ctx.connection.link();
    containerEl.empty();
    containerEl.classList.add(P);
    const save = (fn: Parameters<typeof ctx.settings.update>[0], redraw = false) =>
      void ctx.settings.update(fn).then(() => {
        if (redraw) this.display();
      });
    const note = (text: string) => this.p(text);

    // 1. Link
    new Setting(containerEl).setName(m.link).setHeading();
    if (!link) {
      new Setting(containerEl).setName(m.notLinked).addButton((b) =>
        b
          .setButtonText(m.connect)
          .setCta()
          .onClick(() => void ctx.openWelcome()),
      );
    } else {
      new Setting(containerEl).setName(m.server).setDesc(link.host);
      if (link.server.startsWith("http:")) note(m.insecure);
      new Setting(containerEl).setName(m.user).setDesc(link.user);
      new Setting(containerEl).setName(m.vault).setDesc(link.vaultName);
      new Setting(containerEl).setName(m.deviceName).addText((text) => {
        text.setValue(link.deviceName);
        text.inputEl.addEventListener("blur", () => {
          const name = text.getValue().trim();
          if (name && name !== link.deviceName) void ctx.connection.renameDevice(name);
        });
      });
      new Setting(containerEl)
        .setName(m.addDevice)
        .setDesc(m.addDeviceDesc)
        .addButton((b) => b.setButtonText(m.addDevice).onClick(() => ctx.openAddDevice()));
      new Setting(containerEl)
        .setName(m.unlink)
        .setDesc(m.unlinkDesc)
        .addButton((b) =>
          b
            .setButtonText(m.unlink)
            .setWarning()
            .onClick(async () => {
              const ok = await ctx.confirm({
                title: m.unlinkTitle,
                text: m.unlinkText,
                confirmText: m.confirmUnlink,
                cancelText: m.cancel,
                warning: true,
              });
              if (!ok) return;
              await ctx.connection.unlink();
              this.display();
            }),
        );
    }

    // 2. Sync
    new Setting(containerEl).setName(m.sync).setHeading();
    if (!ctx.engineAvailable) note(m.notActive);
    new Setting(containerEl)
      .setName(m.mode)
      .setDesc(m.modeDesc)
      .addDropdown((d) => {
        for (const mode of ["live", "periodic", "manual"] as const)
          d.addOption(mode, m.modes[mode]);
        d.setValue(s.sync.mode).onChange((v) =>
          save((x) => ({ ...x, sync: { ...x.sync, mode: v as SyncMode } }), true),
        );
      });
    if (s.sync.mode === "live") {
      new Setting(containerEl)
        .setName(m.debounce)
        .setDesc(m.debounceDesc)
        .addText((text) => {
          text.inputEl.type = "number";
          text
            .setValue(String(s.sync.liveDebounceSec))
            .onChange((v) =>
              save((x) => ({ ...x, sync: { ...x.sync, liveDebounceSec: Number(v) } })),
            );
        });
    }
    if (s.sync.mode === "periodic") {
      new Setting(containerEl).setName(m.periodic).addText((text) => {
        text.inputEl.type = "number";
        text
          .setValue(String(s.sync.periodicMinutes))
          .onChange((v) =>
            save((x) => ({ ...x, sync: { ...x.sync, periodicMinutes: Number(v) } })),
          );
      });
    }

    // 3. Large files
    new Setting(containerEl).setName(m.largeFiles).setHeading();
    new Setting(containerEl)
      .setName(m.wifiOnly)
      .setDesc(m.wifiOnlyDesc)
      .addToggle((tg) =>
        tg
          .setValue(s.largeFiles.wifiOnly)
          .onChange((v) => save((x) => ({ ...x, largeFiles: { ...x.largeFiles, wifiOnly: v } }))),
      );
    new Setting(containerEl).setName(m.threshold).addText((text) => {
      text.inputEl.type = "number";
      text
        .setValue(String(s.largeFiles.thresholdMb))
        .onChange((v) =>
          save((x) => ({ ...x, largeFiles: { ...x.largeFiles, thresholdMb: Number(v) } })),
        );
    });
    if (ctx.isIos) note(m.iosNote);

    // 4. Exclusions
    new Setting(containerEl).setName(m.exclusions).setHeading();
    const invalid = this.p("");
    const showInvalid = () => {
      invalid.textContent = this.invalidGlobs.length
        ? fmt(m.invalidGlobs, { list: this.invalidGlobs.join(", ") })
        : "";
    };
    new Setting(containerEl)
      .setName(m.exclusions)
      .setDesc(m.exclusionsDesc)
      .addTextArea((area) => {
        area.setValue(s.exclusions.join("\n")).onChange((v) => {
          const lines = v
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          this.invalidGlobs = lines.filter((l) => !validateGlob(l));
          showInvalid();
          save((x) => ({ ...x, exclusions: lines.filter(validateGlob) }));
        });
      });
    containerEl.append(invalid);
    showInvalid();
    note(m.alwaysExcluded);

    // 5. Configuration folder
    new Setting(containerEl).setName(fmt(m.configDir, { dir: ctx.configDir })).setHeading();
    new Setting(containerEl)
      .setName(m.useVaultDefault)
      .addToggle((tg) =>
        tg
          .setValue(s.configDir.useVaultDefault)
          .onChange((v) =>
            save((x) => ({ ...x, configDir: { ...x.configDir, useVaultDefault: v } }), true),
          ),
      );
    if (!s.configDir.useVaultDefault) {
      for (const c of CONFIG_CATEGORIES) {
        new Setting(containerEl).setName(m.categories[c]).addToggle((tg) =>
          tg.setValue(s.configDir.categories[c]).onChange((v) =>
            save((x) => ({
              ...x,
              configDir: { ...x.configDir, categories: { ...x.configDir.categories, [c]: v } },
            })),
          ),
        );
      }
    }
    note(m.configNote);

    // 6. About
    new Setting(containerEl).setName(m.about).setHeading();
    new Setting(containerEl).setName(m.version).setDesc(APP_VERSION);
    new Setting(containerEl).setName(m.release).setDesc(APP_CODENAME);
    new Setting(containerEl).setName(m.protocol).setDesc(String(PROTOCOL_VERSION));
    new Setting(containerEl)
      .setName(m.diagnostics)
      .setDesc(m.diagnosticsDesc)
      .addButton((b) =>
        b.setButtonText(m.copyDiagnostics).onClick(() => void ctx.copyDiagnostics()),
      );
  }

  private p(text: string): HTMLParagraphElement {
    const el = this.containerEl.ownerDocument.createElement("p");
    el.className = `${P}__note`;
    el.textContent = text;
    this.containerEl.append(el);
    return el;
  }
}
