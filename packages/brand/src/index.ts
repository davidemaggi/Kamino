/**
 * Single source of truth for product naming (N-10).
 * Renaming the product starts here; see docs/renaming.md for the places
 * that cannot read this module.
 */

export const PRODUCT_NAME = "Kamino";
/** Technical name: obsidian:// URIs, identifiers. */
export const PRODUCT_SLUG = "kamino";
/** Action of the obsidian:// link handled by the plugin (QR / magic link). */
export const PROTOCOL_ACTION = PRODUCT_SLUG;
/** Obsidian plugin id; must not contain the word "obsidian". */
export const PLUGIN_ID = "kamino-sync";
export const ENV_PREFIX = "KAMINO_";
export const PACKAGE_SCOPE = "@kamino";

/** Returns the prefixed environment variable name, e.g. envName("PUBLIC_URL") === "KAMINO_PUBLIC_URL". */
export function envName(key: string): string {
  return `${ENV_PREFIX}${key}`;
}
export * from "./release-names.js";
