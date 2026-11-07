export const PROTOCOL_VERSION = 1;
export const PROTOCOL_MIN_SUPPORTED = 1;

export type ProtocolRange = { min: number; max: number };

export type NegotiationResult =
  { ok: true; version: number } | { ok: false; reason: "client_too_old" | "server_too_old" };

/** Picks the highest protocol version supported by both sides. */
export function negotiateProtocol(client: ProtocolRange, server: ProtocolRange): NegotiationResult {
  if (client.min > client.max || server.min > server.max) {
    return { ok: false, reason: client.max < server.min ? "client_too_old" : "server_too_old" };
  }
  if (client.max < server.min) return { ok: false, reason: "client_too_old" };
  if (client.min > server.max) return { ok: false, reason: "server_too_old" };
  return { ok: true, version: Math.min(client.max, server.max) };
}
