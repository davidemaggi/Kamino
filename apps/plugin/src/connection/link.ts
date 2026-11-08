/** Pairing link: obsidian://<action>?server=<url>&token=<token> (protocol §10, ADR-0012). */
export interface PairingLink {
  server: string;
  token: string;
}

export type LinkParseResult =
  | { ok: true; link: PairingLink }
  | { ok: false; reason: "missing_server" | "invalid_server" | "missing_token" | "not_a_link" };

/** Validates the parameters Obsidian passes to the protocol handler. Never throws. */
export function parsePairingLink(params: Record<string, string | undefined>): LinkParseResult {
  const server = params["server"]?.trim();
  const token = params["token"]?.trim();
  if (!server) return { ok: false, reason: "missing_server" };
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return { ok: false, reason: "invalid_server" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { ok: false, reason: "invalid_server" };
  if (!token) return { ok: false, reason: "missing_token" };
  return { ok: true, link: { server: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, token } };
}

/** Parses a pasted link (desktop "paste the link" field). Never throws. */
export function parsePairingUrl(text: string, action: string): LinkParseResult {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { ok: false, reason: "not_a_link" };
  }
  if (url.protocol !== "obsidian:" || url.hostname !== action)
    return { ok: false, reason: "not_a_link" };
  return parsePairingLink(Object.fromEntries(url.searchParams));
}

export function buildPairingLink(action: string, link: PairingLink): string {
  return `obsidian://${action}?server=${encodeURIComponent(link.server)}&token=${encodeURIComponent(link.token)}`;
}
