import { describe, expect, it } from "vitest";
import { MockAdapter } from "../__mocks__/obsidian.js";
import { loadText, saveText } from "./file.js";

const P = ".obsidian/plugins/kamino/diagnostics.log";

describe("diagnostics file", () => {
  it("missing file reads as empty", async () => {
    expect(await loadText(new MockAdapter() as never, P)).toBe("");
  });

  it("saves through a temporary file and replaces the old one", async () => {
    const a = new MockAdapter();
    await saveText(a as never, P, "one\n");
    await saveText(a as never, P, "two\n");
    expect(await loadText(a as never, P)).toBe("two\n");
    expect(await a.exists(`${P}.tmp`)).toBe(false);
  });

  it("a save interrupted after removing the old file is recovered from the temporary one", async () => {
    const a = new MockAdapter();
    await a.write(`${P}.tmp`, "kept\n");
    expect(await loadText(a as never, P)).toBe("kept\n");
  });
});
