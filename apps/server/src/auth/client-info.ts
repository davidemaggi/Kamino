/** "Firefox · macOS": what the user sees about a session (never the raw user agent). */
export function describeClient(ua: string | undefined): string {
  if (!ua) return "?";
  const app = /obsidian/i.test(ua)
    ? "Obsidian"
    : /edg\//i.test(ua)
      ? "Edge"
      : /firefox\//i.test(ua)
        ? "Firefox"
        : /chrome\//i.test(ua)
          ? "Chrome"
          : /safari\//i.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iphone|ipad/i.test(ua)
    ? "iOS"
    : /android/i.test(ua)
      ? "Android"
      : /mac os x|macintosh/i.test(ua)
        ? "macOS"
        : /windows/i.test(ua)
          ? "Windows"
          : /linux/i.test(ua)
            ? "Linux"
            : "?";
  return `${app} · ${os}`;
}

/** Truncated address: "192.168.1.x", "2001:db8:85a3:x". */
export function ipPrefix(ip: string | undefined): string {
  if (!ip) return "?";
  const v4 = /(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`;
  const groups = ip.split(":").filter(Boolean);
  return `${groups.slice(0, 3).join(":")}:x`;
}
