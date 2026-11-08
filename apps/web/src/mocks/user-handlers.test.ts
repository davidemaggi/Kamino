// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { api } from "../api/endpoints.js";
import { ApiError } from "../api/http.js";
import { signInAs } from "./db.js";
import { simulatePairingRequest, simulateStaleNext, ud } from "./userdata.js";

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof ApiError ? e.code : "?"),
  );

describe("user area fake API", () => {
  it("vaults, rename, retention, delete with confirmation", async () => {
    signInAs("demo");
    const list = await api.vaults();
    expect(list.vaults.map((v) => v.name)).toEqual(["Note", "Lavoro"]);
    expect(list.quota.limitBytes).not.toBeNull();
    expect(
      (await api.updateVault("v-notes", { name: "Appunti", retentionDays: 60 })).retentionDays,
    ).toBe(60);
    expect(await code(api.deleteVault("v-work", "lavoro"))).toBe("confirm_mismatch");
    await api.deleteVault("v-work", "Lavoro");
    expect((await api.vaults()).vaults).toHaveLength(1);
  });

  it("ZIP now and within the history window; outside → history_window", async () => {
    signInAs("demo");
    expect((await api.downloadZip("v-notes")).size).toBeGreaterThan(0);
    expect(await code(api.downloadZip("v-notes", "2020-01-01T00:00:00Z"))).toBe("history_window");
  });

  it("devices: rename and revoke", async () => {
    signInAs("demo");
    expect((await api.devices()).length).toBe(5);
    expect((await api.renameDevice("d-mac", "Studio")).name).toBe("Studio");
    expect((await api.revokeDevice("d-iphone")).revoked).toBe(true);
  });

  it("pairing from the web: waiting → requested → approved; answering twice → pairing_closed", async () => {
    signInAs("demo");
    const offer = await api.startPairing("v-notes");
    expect(offer.link).toContain("obsidian://");
    expect((await api.pairing(offer.pairingId)).status).toBe("waiting");
    simulatePairingRequest();
    const st = await api.pairing(offer.pairingId);
    expect(st).toMatchObject({ status: "requested", request: { code: "K7RX" } });
    await api.approvePairing(offer.pairingId);
    expect((await api.pairing(offer.pairingId)).status).toBe("approved");
    expect(await code(api.denyPairing(offer.pairingId))).toBe("pairing_closed");
  });

  it("conflicts: resolve, stale, gone, resolve all", async () => {
    signInAs("demo");
    const list = await api.conflicts();
    expect(list).toHaveLength(3);
    const c = await api.conflict("c-shopping");
    simulateStaleNext();
    expect(await code(api.resolveConflict("c-shopping", "keep_mine", c.incoming.at))).toBe(
      "stale_resolution",
    );
    const fresh = await api.conflict("c-shopping");
    expect(fresh.incoming.at).not.toBe(c.incoming.at);
    await api.resolveConflict("c-shopping", { manual: "merged" }, fresh.incoming.at);
    expect(await code(api.resolveConflict("c-shopping", "keep_mine", fresh.incoming.at))).toBe(
      "not_found",
    );
    expect(await api.resolveAll("keep_both", ["c-plan", "c-photo"])).toEqual({ resolved: 2 });
    expect(ud.vaults.every((v) => v.conflicts === 0)).toBe(true);
  });

  it("history and trash", async () => {
    signInAs("demo");
    const files = await api.files("v-notes", "idee");
    expect(files.files.map((f) => f.path)).toEqual(["Idee.md"]);
    const versions = await api.fileVersions("f-idee");
    expect(versions.versions.filter((v) => v.current)).toHaveLength(1);
    const old = versions.versions.find((v) => !v.current)!;
    expect((await api.version(old.id)).text).toContain("Versione");
    await api.restoreVersion(old.id);
    expect((await api.fileVersions("f-idee")).versions).toHaveLength(versions.versions.length + 1);
    const trash = await api.trash("v-notes");
    await api.restoreTrash(trash.items[0]!.fileId);
    expect((await api.trash("v-notes")).items).toHaveLength(trash.items.length - 1);
  });
});
