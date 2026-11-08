import { describe, expect, it } from "vitest";
import {
  ENV_PREFIX,
  PACKAGE_SCOPE,
  PLUGIN_ID,
  PRODUCT_NAME,
  PRODUCT_SLUG,
  PROTOCOL_ACTION,
  envName,
} from "./index.js";

describe("brand", () => {
  it("builds prefixed environment variable names", () => {
    expect(envName("PUBLIC_URL")).toBe("KAMINO_PUBLIC_URL");
    expect(envName("PUBLIC_URL")).toBe(`${ENV_PREFIX}PUBLIC_URL`);
  });

  it("keeps the plugin id free of the word obsidian", () => {
    expect(PLUGIN_ID.toLowerCase()).not.toContain("obsidian");
  });

  it("uses a technical slug safe for URIs", () => {
    expect(PRODUCT_SLUG).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("exposes the product constants", () => {
    expect(PRODUCT_NAME).toBe("Kamino");
    expect(PACKAGE_SCOPE).toBe(`@${PRODUCT_SLUG}`);
  });

  it("protocol action is the product slug", () => {
    expect(PROTOCOL_ACTION).toBe(PRODUCT_SLUG);
  });
});
