import { VersionInfo } from "@kamino/protocol";

export async function fetchVersion(signal?: AbortSignal): Promise<VersionInfo> {
  const init: RequestInit = { headers: { accept: "application/json" } };
  if (signal) init.signal = signal;
  const res = await fetch("/version", init);
  if (!res.ok) throw new Error(`GET /version failed: ${res.status}`);
  return VersionInfo.parse(await res.json());
}
