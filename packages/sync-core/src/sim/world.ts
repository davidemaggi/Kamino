import type { JournalEntry, Op, OpResult, Snapshot } from "@kamino/protocol";
import {
  initialState,
  step,
  type ClientEvent,
  type ClientState,
  type Durable,
  type Effect,
} from "../client.js";
import { classify, DEFAULT_SETTINGS, type SyncSettings } from "../exclusions.js";
import { collisionKey, isRepresentable, normalizePath, type Platform } from "../paths.js";
import { checkInvariants, MemoryStore } from "../store.js";

const CONFIG_DIR = ".obsidian";

type Msg =
  | { to: "server"; client: number; requestId: string; kind: "push"; ops: Op[]; blobs: string[] }
  | { to: "server"; client: number; requestId: string; kind: "pull"; after: number }
  | { to: "server"; client: number; requestId: string; kind: "snapshot" }
  | { to: "client"; client: number; event: ClientEvent & { requestId: string } };

type FsEffect = Extract<Effect, { type: "write" | "rename" | "trash" }>;

interface SimClient {
  platform: Platform;
  deviceId: string;
  state: ClientState;
  persisted: Durable;
  /** Disk: key of the local path → file (local path). Case-insensitive platforms key by collisionKey. */
  disk: Map<string, { path: string; hash: string }>;
  queue: ClientEvent[];
  /** File effects issued but not yet performed: the shell is asynchronous. */
  pendingFs: FsEffect[];
  /** Disk keys that received a file through a rename the watcher didn't see. */
  movedHere: Set<string>;
}

export interface ClientSpec {
  platform: Platform;
  files: Array<[string, string]>;
  /** Device exclusion patterns (canonical globs); default: the vault defaults. */
  patterns?: string[];
}

export type Action =
  /** User writes a new or existing file; every write is a never-seen content. */
  | { t: "write"; c: number; path: string; hash: string }
  /** `pick` chooses among the files on that client's disk. */
  | { t: "edit"; c: number; pick: number; hash: string }
  | { t: "remove"; c: number; pick: number }
  | { t: "rename"; c: number; pick: number; to: string; watched: boolean }
  /** The device changes its exclusion patterns. */
  | { t: "settings"; c: number; patterns: string[] }
  | { t: "sync"; c: number; crashAt: number | null }
  /** A full cycle: sync, then deliver every message and finish every file effect. */
  | { t: "cycle"; c: number }
  /** Perform one pending file effect of a client. */
  | { t: "fs"; c: number; k: number; crashAt: number | null }
  | { t: "deliver"; k: number; crashAt: number | null }
  | { t: "drop"; k: number }
  /** The client times out but the message is still delivered later. */
  | { t: "timeout"; k: number }
  | { t: "dup"; k: number }
  /** The next push response carries only its first result. */
  | { t: "truncate" }
  /** While on, the server refuses puts with quota_exceeded. */
  | { t: "quota"; on: boolean }
  | { t: "crash"; c: number };

/** N clients, one server, a network that loses, duplicates and reorders, and crashes (02 §5). */
export class World {
  readonly store = new MemoryStore();
  readonly clients: SimClient[];
  net: Msg[] = [];
  readonly violations: string[] = [];
  private ids = 0;
  private writes = 0;
  private truncateNext = false;
  private quotaFull = false;
  private readonly env = { newId: () => `id-${++this.ids}` };
  /** Contents a user removed or overwrote somewhere: only these may leave the live state. */
  private readonly userRemoved = new Set<string>();
  /** Contents created by user writes (unique), with the client that wrote them. */
  private readonly userWritten = new Map<string, number>();
  /** Contents moved by renames the watcher didn't see: delete + create, so copies are legitimate. */
  private readonly unseenMoves = new Set<string>();

  constructor(specs: ClientSpec[]) {
    this.clients = specs.map((spec, i) => {
      const deviceId = `dev-${i}`;
      const settings: SyncSettings = {
        ...DEFAULT_SETTINGS,
        patterns: spec.patterns ?? DEFAULT_SETTINGS.patterns,
      };
      const state = initialState({
        deviceId,
        platform: spec.platform,
        configDir: CONFIG_DIR,
        settings,
        batchSize: 4,
      });
      const c: SimClient = {
        platform: spec.platform,
        deviceId,
        state,
        persisted: state.durable,
        disk: new Map(),
        queue: [],
        pendingFs: [],
        movedHere: new Set(),
      };
      for (const [path, hash] of spec.files)
        if (this.canExist(c, path)) this.diskSet(c, path, hash);
      return c;
    });
  }

  private key(c: SimClient, path: string): string {
    return c.platform === "linux" ? path : collisionKey(path);
  }
  private canExist(c: SimClient, path: string): boolean {
    return isRepresentable(path, c.platform).ok;
  }
  private canonical(path: string): string {
    const r = normalizePath(path, CONFIG_DIR);
    return r.ok ? r.path : path;
  }
  private excluded(c: SimClient, localPath: string): boolean {
    return classify(this.canonical(localPath), c.state.config.settings, c.platform !== "linux")
      .excluded;
  }
  private diskSet(c: SimClient, path: string, hash: string): void {
    const k = this.key(c, path);
    const existing = c.disk.get(k);
    if (existing) this.userRemoved.add(existing.hash);
    c.disk.set(k, { path: existing?.path ?? path, hash });
  }
  private unique(seed: string, c: number): string {
    const h = `${seed.slice(0, 1)}~${++this.writes}`;
    this.userWritten.set(h, c);
    return h;
  }

  act(a: Action): void {
    switch (a.t) {
      case "write": {
        const c = this.clients[a.c]!;
        if (this.canExist(c, a.path)) this.diskSet(c, a.path, this.unique(a.hash, a.c));
        return;
      }
      case "edit": {
        const c = this.clients[a.c]!;
        const f = this.pick(c, a.pick);
        if (f) this.diskSet(c, f.path, this.unique(a.hash, a.c));
        return;
      }
      case "remove": {
        const c = this.clients[a.c]!;
        const f = this.pick(c, a.pick);
        if (f) {
          this.userRemoved.add(f.hash);
          c.disk.delete(this.key(c, f.path));
        }
        return;
      }
      case "rename": {
        const c = this.clients[a.c]!;
        const from = this.pick(c, a.pick);
        if (!from || !this.canExist(c, a.to)) return;
        const toKey = this.key(c, a.to);
        if (c.disk.has(toKey) && toKey !== this.key(c, from.path)) return;
        // A move into an excluded area takes the file out of the synced vault (C1 keeps the server copy
        // when the watcher saw it: covered by client tests).
        if (this.excluded(c, a.to) && !this.excluded(c, from.path)) this.userRemoved.add(from.hash);
        if (!a.watched) {
          this.unseenMoves.add(from.hash);
          c.movedHere.add(toKey);
        }
        c.disk.delete(this.key(c, from.path));
        c.disk.set(toKey, { path: a.to, hash: from.hash });
        if (a.watched)
          this.feed(
            a.c,
            { type: "localRename", from: this.canonical(from.path), to: this.canonical(a.to) },
            null,
          );
        return;
      }
      case "settings": {
        const c = this.clients[a.c]!;
        // A file that arrived through an unseen move and is now excluded has left the synced vault.
        c.state = {
          ...c.state,
          config: {
            ...c.state.config,
            settings: { ...c.state.config.settings, patterns: a.patterns },
          },
        };
        for (const [key, f] of c.disk)
          if (c.movedHere.has(key) && this.excluded(c, f.path)) this.userRemoved.add(f.hash);
        return;
      }
      case "sync":
        this.finishFs(a.c);
        this.feed(a.c, { type: "sync", scan: this.scan(this.clients[a.c]!) }, a.crashAt);
        return;
      case "cycle":
        this.finishFs(a.c);
        this.feed(a.c, { type: "sync", scan: this.scan(this.clients[a.c]!) }, null);
        this.flush();
        return;
      case "fs": {
        const c = this.clients[a.c]!;
        if (c.pendingFs.length > 0) this.performFs(a.c, a.k % c.pendingFs.length, a.crashAt);
        return;
      }
      case "deliver":
        this.deliver(a.k, a.crashAt);
        return;
      case "drop": {
        if (this.net.length === 0) return;
        const [m] = this.net.splice(a.k % this.net.length, 1);
        // A lost request or response looks like a timeout to the client.
        if (m) this.feed(m.client, { type: "networkError", requestId: this.requestId(m) }, null);
        return;
      }
      case "timeout": {
        if (this.net.length === 0) return;
        const m = this.net[a.k % this.net.length]!;
        this.feed(m.client, { type: "networkError", requestId: this.requestId(m) }, null);
        return;
      }
      case "dup":
        if (this.net.length > 0) this.net.push(this.net[a.k % this.net.length]!);
        return;
      case "truncate":
        this.truncateNext = true;
        return;
      case "quota":
        this.quotaFull = a.on;
        return;
      case "crash":
        this.crash(a.c);
        return;
    }
  }

  private requestId(m: Msg): string {
    return m.to === "server" ? m.requestId : m.event.requestId;
  }

  private pick(c: SimClient, n: number): { path: string; hash: string } | undefined {
    const files = [...c.disk.values()];
    return files.length === 0 ? undefined : files[n % files.length];
  }

  /** What the shell reports: canonical paths. */
  private scan(c: SimClient) {
    return [...c.disk.values()].map((f) => ({
      path: this.canonical(f.path),
      hash: f.hash,
      size: 1,
      mtime: 0,
    }));
  }

  private crash(i: number): void {
    const c = this.clients[i]!;
    c.state = {
      config: c.state.config,
      durable: JSON.parse(JSON.stringify(c.persisted)) as Durable,
      vol: { phase: "idle", requestId: null, stopped: null },
    };
    c.queue = [];
    c.pendingFs = [];
  }

  /** Runs an event and every event its effects cause; `crashAt` = crash after that many effects. */
  private feed(i: number, event: ClientEvent, crashAt: number | null): void {
    this.clients[i]!.queue.push(event);
    this.drain(i, crashAt);
  }

  private drain(i: number, crashAt: number | null): void {
    const c = this.clients[i]!;
    let budget = crashAt;
    while (c.queue.length > 0) {
      const ev = c.queue.shift()!;
      const out = step(c.state, ev, this.env);
      c.state = out.state;
      for (const fx of out.effects) {
        if (budget !== null && budget-- <= 0) {
          this.crash(i);
          return;
        }
        this.run(i, fx);
      }
    }
  }

  private run(i: number, fx: Effect): void {
    const c = this.clients[i]!;
    switch (fx.type) {
      case "persist":
        c.persisted = JSON.parse(JSON.stringify(c.state.durable)) as Durable;
        return;
      case "snapshot":
        this.net.push({ to: "server", client: i, requestId: fx.requestId, kind: "snapshot" });
        return;
      case "push": {
        // The shell reads the contents at send time: only what is on disk now can be uploaded.
        const onDisk = new Set([...c.disk.values()].map((f) => f.hash));
        this.net.push({
          to: "server",
          client: i,
          requestId: fx.requestId,
          kind: "push",
          ops: fx.ops,
          blobs: fx.hashes.filter((h) => onDisk.has(h)),
        });
        return;
      }
      case "pull":
        this.net.push({
          to: "server",
          client: i,
          requestId: fx.requestId,
          kind: "pull",
          after: fx.after,
        });
        return;
      case "write":
      case "rename":
      case "trash":
        c.pendingFs.push(fx);
        return;
      case "ack":
        this.store.cursors.set(c.deviceId, fx.seq);
        return;
      case "notify":
        return;
    }
  }

  /** Shell contract: a scan is only reported once every issued file effect has completed. */
  private finishFs(i: number): void {
    while (this.clients[i]!.pendingFs.length > 0) this.performFs(i, 0, null);
  }

  private performFs(i: number, k: number, crashAt: number | null): void {
    const c = this.clients[i]!;
    const [fx] = c.pendingFs.splice(k, 1);
    if (!fx) return;
    switch (fx.type) {
      case "write": {
        const key = this.key(c, fx.path);
        const cur = c.disk.get(key)?.hash ?? null;
        if (cur !== fx.expect) {
          c.queue.push({ type: "written", fileId: fx.fileId, hash: fx.hash, ok: false });
          break;
        }
        if (cur !== null && !this.store.hasContent(cur))
          this.violations.push(`client ${i} overwrote content the server doesn't have: ${fx.path}`);
        c.disk.set(key, { path: c.disk.get(key)?.path ?? fx.path, hash: fx.hash });
        c.queue.push({ type: "written", fileId: fx.fileId, hash: fx.hash, ok: true });
        break;
      }
      case "rename": {
        const from = c.disk.get(this.key(c, fx.from));
        const toKey = this.key(c, fx.to);
        const ok =
          !!from &&
          (!c.disk.has(toKey) || toKey === this.key(c, fx.from)) &&
          this.canExist(c, fx.to);
        if (ok) {
          c.disk.delete(this.key(c, fx.from));
          c.disk.set(toKey, { path: fx.to, hash: from.hash });
        }
        c.queue.push({ type: "renamed", fileId: fx.fileId, to: fx.toPath, ok });
        break;
      }
      case "trash": {
        const key = this.key(c, fx.path);
        const cur = c.disk.get(key)?.hash ?? null;
        if (cur !== fx.expect) {
          c.queue.push({ type: "trashed", fileId: fx.fileId, ok: false });
          break;
        }
        if (!this.store.hasContent(fx.expect))
          this.violations.push(`client ${i} trashed content the server doesn't have: ${fx.path}`);
        c.disk.delete(key);
        c.queue.push({ type: "trashed", fileId: fx.fileId, ok: true });
        break;
      }
    }
    this.drain(i, crashAt);
  }

  private deliver(k: number, crashAt: number | null): void {
    if (this.net.length === 0) return;
    const [m] = this.net.splice(k % this.net.length, 1);
    if (!m) return;
    if (m.to === "client") {
      this.feed(m.client, m.event, crashAt);
      return;
    }
    const deviceId = this.clients[m.client]!.deviceId;
    let event: ClientEvent & { requestId: string };
    if (m.kind === "push") {
      for (const h of m.blobs) this.store.blobs.add(h);
      let results: OpResult[];
      if (this.quotaFull) {
        // Puts refused (nothing recorded); the rest goes through.
        // Recorded ops still come back as duplicates (the server checks them first).
        results = m.ops.map((op) =>
          op.type === "put" && !this.store.results.has(op.opId)
            ? ({ status: "rejected", code: "quota_exceeded" } as const)
            : (this.store.commit([op], deviceId).results[0] as OpResult),
        );
      } else results = this.store.commit(m.ops, deviceId).results as OpResult[];
      for (const problem of checkInvariants(this.store)) this.violations.push(`server: ${problem}`);
      if (this.truncateNext) {
        this.truncateNext = false;
        results = results.slice(0, 1);
      }
      event = { type: "pushResult", requestId: m.requestId, results, head: this.store.head };
    } else if (m.kind === "pull") {
      const res = this.store.changes(m.after, 3);
      event = {
        type: "pullResult",
        requestId: m.requestId,
        entries: res.entries as JournalEntry[],
        head: res.head,
        hasMore: res.hasMore,
      };
    } else {
      event = {
        type: "snapshotResult",
        requestId: m.requestId,
        snapshot: this.store.snapshot() as Snapshot,
      };
    }
    this.net.push({ to: "client", client: m.client, event });
  }

  /** Deliver every message and perform every file effect, until nothing is pending. */
  private flush(): void {
    for (let guard = 0; guard < 10_000; guard++) {
      if (this.net.length > 0) {
        this.deliver(0, null);
        continue;
      }
      const i = this.clients.findIndex((c) => c.pendingFs.length > 0);
      if (i < 0) return;
      this.performFs(i, 0, null);
    }
  }

  /** No more faults: sync everyone until nothing moves. Returns false if it never settles. */
  settle(maxRounds = 40): boolean {
    this.quotaFull = false;
    this.truncateNext = false;
    for (let round = 0; round < maxRounds; round++) {
      for (let i = 0; i < this.clients.length; i++) {
        this.act({ t: "sync", c: i, crashAt: null });
        this.flush();
      }
      if (this.quiet()) return true;
    }
    return false;
  }

  /** Quiet = a dry-run sync cycle on a copy produces nothing to do but persist and pull. */
  private quiet(): boolean {
    return this.clients.every((c) => {
      const s = c.state;
      if (!s.durable.joined || s.vol.phase !== "idle" || s.durable.cursor !== this.store.head)
        return false;
      if (c.pendingFs.length > 0) return false;
      const probe = step(s, { type: "sync", scan: this.scan(c) }, { newId: () => "probe" });
      return probe.effects.every((fx) => fx.type === "persist" || fx.type === "pull");
    });
  }

  /** Convergence, "nothing lost" and "nothing removed that no user removed" (spec §4.1–2). */
  check(): string[] {
    const out = [...this.violations];
    const live = [...this.store.files.values()].filter((f) => f.kind === "file" && !f.deleted);
    const candidates = new Set([...this.store.conflicts.values()].flatMap((c) => c.candidates));
    const liveContents = new Set<string>(live.map((f) => f.headHash ?? ""));
    for (const v of candidates) liveContents.add(this.store.versions.get(v)?.hash ?? "");
    const kept = new Set<string>(); // contents a client keeps locally on purpose (conflicts, exclusions)

    this.clients.forEach((c, i) => {
      const index = c.state.durable.index;
      for (const f of live) {
        const e = index[f.fileId];
        if (!e) {
          out.push(`client ${i} doesn't know ${f.path}`);
          continue;
        }
        if (e.unavailable || e.conflictId || e.ignored) continue;
        const occupant = Object.values(index).find(
          (o) =>
            o !== e &&
            (o.conflictId || o.ignored) &&
            o.localHash !== null &&
            this.key(c, o.path) === this.key(c, f.path),
        );
        if (occupant) continue; // a local copy kept on purpose holds the path on this device
        const onDisk = c.disk.get(this.key(c, this.localOf(f.path)));
        if (!onDisk || onDisk.hash !== f.headHash || this.canonical(onDisk.path) !== f.path)
          out.push(
            `client ${i}: ${f.path} is ${onDisk ? `${onDisk.path}=${onDisk.hash}` : "missing"}, server has ${f.headHash}`,
          );
      }
      for (const d of c.disk.values()) {
        const canon = this.canonical(d.path);
        if (this.excluded(c, d.path)) {
          kept.add(d.hash);
          continue;
        }
        const e = Object.values(index).find(
          (x) => x.localHash !== null && this.key(c, this.localOf(x.path)) === this.key(c, d.path),
        );
        if (!e) {
          out.push(`client ${i}: ${canon} on disk but not tracked`);
          continue;
        }
        if (e.conflictId || e.ignored) {
          kept.add(d.hash); // local edits after a conflict stay local until it's resolved (M3)
          continue;
        }
        if (!this.store.hasContent(d.hash))
          out.push(`client ${i}: content of ${canon} never reached the server`);
        if (!e.unavailable && !live.some((f) => f.fileId === e.fileId))
          out.push(`client ${i}: ${canon} is not a live file on the server`);
      }
    });

    // Nothing leaves the live state unless a user removed or overwrote it somewhere, or a device
    // keeps it locally on purpose (a conflicted copy, an excluded file).
    for (const v of this.store.versions.values()) {
      if (!this.userRemoved.has(v.hash) && !liveContents.has(v.hash) && !kept.has(v.hash))
        out.push(`content ${v.hash} left the server's live files without any user removing it`);
    }
    // Every user write reaches the server, unless removed by a user or kept locally on purpose.
    for (const h of this.userWritten.keys()) {
      if (!this.userRemoved.has(h) && !this.store.hasContent(h) && !kept.has(h))
        out.push(`user content ${h} never reached the server`);
    }
    // A user write lives in at most one live file: no spurious duplicates.
    const seen = new Map<string, string>();
    for (const f of live) {
      if (
        f.headHash === null ||
        !this.userWritten.has(f.headHash) ||
        this.unseenMoves.has(f.headHash)
      )
        continue;
      const other = seen.get(f.headHash);
      if (other) out.push(`content ${f.headHash} duplicated in ${other} and ${f.path}`);
      seen.set(f.headHash, f.path);
    }
    return out;
  }

  private localOf(canonical: string): string {
    return canonical.startsWith("{config}/")
      ? `${CONFIG_DIR}${canonical.slice("{config}".length)}`
      : canonical;
  }
}
