// R-5: vault events during massive operations. Generates a synthetic subtree,
// counts create/modify/delete/rename events and times the burst while the
// tester moves a folder with thousands of files.
import { Notice, TFolder, type App, type EventRef, type TAbstractFile } from "obsidian";
import { nowIso, Report } from "./report.ts";
import { ms, Progress, yieldToUi } from "./util.ts";

export const R5_DIR = "kamino-spike-mass";
export const R5_MOVE = `${R5_DIR}/move-me`;
export const R5_TARGET = `${R5_DIR}/moved-here`;

async function ensureFolder(app: App, path: string): Promise<void> {
  if (!app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
}

export async function generateVault(
  app: App,
  device: string,
  total: number,
  toMove: number,
): Promise<void> {
  const r = await Report.create(app, "R-5", device, `generate ${total} files`);
  const progress = new Progress();
  const t0 = performance.now();
  try {
    await ensureFolder(app, R5_DIR);
    await ensureFolder(app, R5_MOVE);
    await ensureFolder(app, R5_TARGET);
    let lastDir = "";
    for (let i = 0; i < total; i++) {
      const inMove = i < toMove;
      const dir = inMove
        ? `${R5_MOVE}/d${String(Math.floor(i / 100)).padStart(3, "0")}`
        : `${R5_DIR}/filler/d${String(Math.floor(i / 100)).padStart(3, "0")}`;
      if (dir !== lastDir) {
        await ensureFolder(app, inMove ? R5_MOVE : `${R5_DIR}/filler`);
        await ensureFolder(app, dir);
        lastDir = dir;
      }
      const path = `${dir}/note-${String(i).padStart(5, "0")}.md`;
      if (!app.vault.getAbstractFileByPath(path)) {
        await app.vault.create(
          path,
          `# Note ${i}\n\nSynthetic note for the R-5 spike. [[note-${String((i + 1) % total).padStart(5, "0")}]]\n`,
        );
      }
      if (i % 250 === 0) {
        progress.set(`R-5 generating ${i}/${total}`);
        await yieldToUi();
      }
    }
    await r.line(
      `- created ${total} notes (${toMove} under ${R5_MOVE}, in subfolders of 100) in ${ms(t0)} ms`,
    );
  } catch (err) {
    await r.line(`- FAILED after ${ms(t0)} ms: ${String(err)}`);
  } finally {
    progress.close();
  }
  await r.done();
}

type Kind = "create" | "modify" | "delete" | "rename";

export class EventCounter {
  #refs: EventRef[] = [];
  #counts: Record<Kind, number> = { create: 0, modify: 0, delete: 0, rename: 0 };
  #renameFolders = 0;
  #renameIntoTarget = 0;
  #first: number | null = null;
  #last: number | null = null;
  #maxGapMs = 0;
  #startedAt = 0;
  #perSecond = new Map<number, number>();

  constructor(private readonly app: App) {}

  get running(): boolean {
    return this.#refs.length > 0;
  }

  start(): void {
    if (this.running) return;
    this.#counts = { create: 0, modify: 0, delete: 0, rename: 0 };
    this.#renameFolders = 0;
    this.#renameIntoTarget = 0;
    this.#first = this.#last = null;
    this.#maxGapMs = 0;
    this.#perSecond.clear();
    this.#startedAt = performance.now();
    const vault = this.app.vault;
    this.#refs = [
      vault.on("create", () => this.#hit("create")),
      vault.on("modify", () => this.#hit("modify")),
      vault.on("delete", () => this.#hit("delete")),
      vault.on("rename", (file: TAbstractFile) => {
        this.#hit("rename");
        if (file instanceof TFolder) this.#renameFolders++;
        if (file.path.startsWith(`${R5_TARGET}/`)) this.#renameIntoTarget++;
      }),
    ];
    new Notice(
      `R-5 counting vault events. Now move "${R5_MOVE}" into "${R5_TARGET}" with the file explorer.`,
      10000,
    );
  }

  #hit(kind: Kind): void {
    const now = performance.now();
    if (this.#last !== null) this.#maxGapMs = Math.max(this.#maxGapMs, now - this.#last);
    this.#first ??= now;
    this.#last = now;
    this.#counts[kind]++;
    const bucket = Math.floor((now - this.#startedAt) / 1000);
    this.#perSecond.set(bucket, (this.#perSecond.get(bucket) ?? 0) + 1);
  }

  async dump(device: string, stop: boolean): Promise<void> {
    // Snapshot first: writing the report note itself fires vault events.
    const counts = { ...this.#counts };
    const renameFolders = this.#renameFolders;
    const renameIntoTarget = this.#renameIntoTarget;
    const first = this.#first;
    const last = this.#last;
    const maxGap = this.#maxGapMs;
    const buckets = [...this.#perSecond.entries()].sort((a, b) => a[0] - b[0]);
    const r = await Report.create(this.app, "R-5", device, "vault event counters");
    const span = first !== null && last !== null ? Math.round(last - first) : 0;
    await r.line(`- counts: ${JSON.stringify(counts)}`);
    await r.line(
      `- rename events for folders: ${renameFolders}, rename events whose new path is under ${R5_TARGET}/: ${renameIntoTarget}`,
    );
    await r.line(
      `- first event at +${first === null ? "-" : Math.round(first - this.#startedAt)} ms from start, burst duration (first→last) ${span} ms, max gap between events ${Math.round(maxGap)} ms`,
    );
    await r.line(
      `- events per second (second: count): ${buckets.map(([s, n]) => `${s}:${n}`).join(", ") || "none"}`,
    );
    await r.line(`- dumped at ${nowIso()}`);
    if (stop) {
      for (const ref of this.#refs) this.app.vault.offref(ref);
      this.#refs = [];
      await r.line(`- listeners removed`);
    }
    await r.done();
  }
}

/** Repeatable alternative to the drag-and-drop: move via the API (updates links like the UI). */
export async function moveViaApi(app: App): Promise<void> {
  const from = app.vault.getAbstractFileByPath(R5_MOVE);
  if (!(from instanceof TFolder)) {
    new Notice(`R-5: "${R5_MOVE}" not found (already moved? generate first)`);
    return;
  }
  const t0 = performance.now();
  await app.fileManager.renameFile(from, `${R5_TARGET}/move-me`);
  new Notice(
    `R-5: fileManager.renameFile returned after ${ms(t0)} ms. Wait a few seconds, then dump counters.`,
    10000,
  );
}

export async function cleanupMass(app: App, device: string): Promise<void> {
  const folder = app.vault.getAbstractFileByPath(R5_DIR);
  if (!folder) {
    new Notice(`R-5: nothing to clean`);
    return;
  }
  const r = await Report.create(app, "R-5", device, "cleanup");
  const t0 = performance.now();
  await app.vault.delete(folder, true);
  await r.line(`- deleted ${R5_DIR} recursively in ${ms(t0)} ms`);
  await r.done();
}
