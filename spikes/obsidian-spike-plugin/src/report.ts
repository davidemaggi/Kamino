// Result notes: every spike writes a markdown note under RESULTS_DIR so the
// owner can copy numbers from the phone. Notes are written incrementally
// (create, then append), so a crash mid-test still leaves the partial log.
import { apiVersion, normalizePath, Notice, Platform, type App } from "obsidian";

export const RESULTS_DIR = "Kamino spike results";

declare const __SPIKE_VARIANT__: string;
declare const __CM_MERGE_VERSION__: string;
export const SPIKE_VARIANT = __SPIKE_VARIANT__;
export const CM_MERGE_VERSION = __CM_MERGE_VERSION__;

export function platformLabel(): string {
  if (Platform.isIosApp) return "ios";
  if (Platform.isAndroidApp) return "android";
  if (Platform.isMacOS) return "macos";
  if (Platform.isWin) return "windows";
  if (Platform.isLinux) return "linux";
  return "unknown";
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

interface PerfMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/** Chromium-only (desktop, Android WebView). iOS WKWebView has no performance.memory. */
export function heapMb(): string {
  const mem = (performance as unknown as { memory?: PerfMemory }).memory;
  if (!mem) return "n/a";
  const mb = (n: number) => (n / 1048576).toFixed(0);
  return `${mb(mem.usedJSHeapSize)}/${mb(mem.totalJSHeapSize)} (limit ${mb(mem.jsHeapSizeLimit)})`;
}

export function environmentLines(device: string): string[] {
  return [
    `- device label: ${device}`,
    `- platform: ${platformLabel()} (isMobile=${Platform.isMobile}, isMobileApp=${Platform.isMobileApp}, isIosApp=${Platform.isIosApp}, isAndroidApp=${Platform.isAndroidApp}, isTablet=${Platform.isTablet})`,
    `- Obsidian apiVersion: ${apiVersion}`,
    `- userAgent: ${navigator.userAgent}`,
    `- spike build variant: ${SPIKE_VARIANT}, @codemirror/merge ${CM_MERGE_VERSION}`,
    `- JS heap MB (used/total): ${heapMb()}`,
    `- started: ${nowIso()}`,
  ];
}

export class Report {
  private constructor(
    private readonly app: App,
    readonly path: string,
  ) {}

  static async create(app: App, spike: string, device: string, title: string): Promise<Report> {
    const adapter = app.vault.adapter;
    if (!(await adapter.exists(RESULTS_DIR))) await adapter.mkdir(RESULTS_DIR);
    const path = normalizePath(`${RESULTS_DIR}/${spike} ${device} ${stamp()}.md`);
    const header = [`# ${spike}: ${title}`, "", ...environmentLines(device), "", ""].join("\n");
    await adapter.write(path, header);
    return new Report(app, path);
  }

  /** Appends a line immediately (adapter.append), mirroring it to the console. */
  async line(text: string): Promise<void> {
    console.log(`[kamino-spike] ${text}`);
    await this.app.vault.adapter.append(this.path, `${text}\n`);
  }

  async done(): Promise<void> {
    await this.line(`\nfinished: ${nowIso()}`);
    new Notice(`Spike result written to "${this.path}"`, 8000);
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
