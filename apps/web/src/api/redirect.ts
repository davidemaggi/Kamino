const PUBLIC_PREFIXES = ["/login", "/setup", "/forgot", "/reset", "/invite"];

/** Only internal paths: never another origin ("//x", "/\\x", "https://x"), never back to a public page. */
export function safeRedirect(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (
    PUBLIC_PREFIXES.some(
      (p) => value === p || value.startsWith(`${p}/`) || value.startsWith(`${p}?`),
    )
  )
    return "/";
  return value;
}
