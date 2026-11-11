import type { SocketFactory } from "@kamino/sync-engine";

/**
 * The realtime socket on the browser `WebSocket` (allowed in the plugin). The URL is the
 * server's with `/api/v1/ws`; the token goes in `hello`, never in the URL. On a phone only
 * `wss://` (M5): an insecure server never gets a socket.
 */
export function obsidianSocket(server: string, opts: { mobile: boolean }): SocketFactory {
  return (h) => {
    let url: string | null = null;
    try {
      const u = new URL(server);
      const secure = u.protocol === "https:";
      if (secure || !opts.mobile)
        url = `${secure ? "wss:" : "ws:"}//${u.host}${u.pathname.replace(/\/+$/, "")}/api/v1/ws`;
    } catch {
      url = null;
    }
    if (url === null) {
      queueMicrotask(() => h.onClose(1006));
      return { send() {}, close() {} };
    }
    const ws = new WebSocket(url);
    ws.onopen = () => h.onOpen();
    ws.onmessage = (e: MessageEvent) => h.onMessage(String(e.data));
    ws.onclose = (e: CloseEvent) => h.onClose(e.code);
    return {
      send: (d) => {
        if (ws.readyState === 1) ws.send(d);
      },
      close: (code) => ws.close(code ?? 1000),
    };
  };
}
