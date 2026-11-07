// R-2: what does the Network Information API report inside Obsidian mobile?
import { Notice, type App } from "obsidian";
import { nowIso, Report } from "./report.ts";

interface NetworkInformationLike extends EventTarget {
  type?: string;
  effectiveType?: string;
  downlink?: number;
  downlinkMax?: number;
  rtt?: number;
  saveData?: boolean;
}

function connection(): NetworkInformationLike | undefined {
  const nav = navigator as Navigator & {
    connection?: NetworkInformationLike;
    mozConnection?: NetworkInformationLike;
    webkitConnection?: NetworkInformationLike;
  };
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
}

function snapshot(): string {
  const c = connection();
  if (!c) return `navigator.connection ABSENT, onLine=${navigator.onLine}`;
  const v = (x: unknown) => (x === undefined ? "undefined" : JSON.stringify(x));
  return [
    `type=${v(c.type)}`,
    `effectiveType=${v(c.effectiveType)}`,
    `downlink=${v(c.downlink)}`,
    `downlinkMax=${v(c.downlinkMax)}`,
    `rtt=${v(c.rtt)}`,
    `saveData=${v(c.saveData)}`,
    `onLine=${navigator.onLine}`,
  ].join(", ");
}

export async function recordNetwork(app: App, device: string, label: string): Promise<void> {
  const r = await Report.create(app, "R-2", device, `network info (${label})`);
  const c = connection();
  await r.line(`- condition declared by tester: ${label}`);
  await r.line(`- navigator.connection present: ${c !== undefined}`);
  await r.line(`- "type" in connection: ${c ? "type" in c : "n/a"}`);
  await r.line(`- snapshot: ${snapshot()}`);
  await r.done();
}

/** Watches change/online/offline events for 2 minutes while the tester toggles Wi-Fi/cellular. */
export async function watchNetwork(app: App, device: string): Promise<void> {
  const r = await Report.create(app, "R-2", device, "network change watch (2 min)");
  await r.line(`- initial: ${snapshot()}`);
  await r.line(`- now toggle Wi-Fi off/on, airplane mode, etc. Events:`);
  const log = (what: string) => void r.line(`- ${nowIso()} ${what}: ${snapshot()}`);
  const onChange = () => log("connection change");
  const onOnline = () => log("window online");
  const onOffline = () => log("window offline");
  const c = connection();
  c?.addEventListener("change", onChange);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  new Notice("R-2: watching network changes for 2 minutes. Toggle Wi-Fi / cellular now.", 8000);
  await new Promise((resolve) => setTimeout(resolve, 120_000));
  c?.removeEventListener("change", onChange);
  window.removeEventListener("online", onOnline);
  window.removeEventListener("offline", onOffline);
  await r.line(`- final: ${snapshot()}`);
  await r.done();
}
