import type { JournalEntry, Op, OpResult, Snapshot } from "@kamino/protocol";
import {
  initialState,
  nextOps,
  step,
  type ClientEvent,
  type ClientState,
  type Durable,
  type Effect,
} from "../client.js";
import { DEFAULT_SETTINGS } from "../exclusions.js";
import { collisionKey, isRepresentable, type Platform } from "../paths.js";
import { checkInvariants, MemoryStore } from "../store.js";

type Msg =
  | { to: "server"; client: number; requestId: string; kind: "push"; ops: Op[]; blobs: string[] }
  | { to: "server"; client: number; requestId: string; kind: "pull"; after: number }
  | { to: "server"; client: number; requestId: string; kind: "snapshot" }
  | { to: "client"; client: number; event: ClientEvent & { requestId: string } };

interface SimClient {
  platform: Platform;
  deviceId: string;
  state: ClientState;
  persisted: Durable;
  /** Disk: diskKey → file. Case-insensitive platforms key by collisionKey. */
  disk: Map<string, { path: string; hash: string }>;
  queue: ClientEvent[];
}

export interface ClientSpec {
  platform: Platform;
  files: Array<[string, string]>;
}

export type Action =
  | { t: "write"; c: number; path: string; hash: string }
  | { t: "remove"; c: number; path: string }
  | { t: "rename"; c: number; from: string; to: string; watched: boolean }
  | { t: "sync"; c: number; crashAt: number | null }
  | { t: "deliver"; k: number; crashAt: number | null }
  | { t: "drop"; k: number }
  | { t: "dup"; k: number }
  | { t: "crash"; c: number };

/** N clients, one server, a network that loses, duplicates and reorders, and crashes (02 §5). */
export class World {
  readonly store = new MemoryStore();
  readonly clients: SimClient[];
  net: Msg[] = [];
  readonly violations: string[] = [];
  private ids = 0;
  private readonly env = { newId: () => `id-${++this.ids}` };

  constructor(specs: ClientSpec[]) {
    this.clients = specs.map((spec, i) => {
      const deviceId = `dev-${i}`;
      const state = initialState({
        deviceId,
        platform: spec.platform,
        configDir: ".obsidian",
        settings: DEFAULT_SETTINGS,
        batchSize: 4,
      });
      const c: SimClient = {
        platform: spec.platform,
        deviceId,
        state,
        persisted: state.durable,
        disk: new Map(),
        queue: [],
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
  private diskSet(c: SimClient, path: string, hash: string): void {
    const k = this.key(c, path);
    const existing = c.disk.get(k);
    c.disk.set(k, { path: existing?.path ?? path, hash });
  }

  act(a: Action): void {
    switch (a.t) {
      case "write": {
        const c = this.clients[a.c]!;
        if (this.canExist(c, a.path)) this.diskSet(c, a.path, a.hash);
        return;
      }
      case "remove": {
        const c = this.clients[a.c]!;
        c.disk.delete(this.key(c, a.path));
        return;
      }
      case "rename": {
        const c = this.clients[a.c]!;
        const from = c.disk.get(this.key(c, a.from));
        if (!from || !this.canExist(c, a.to)) return;
        const toKey = this.key(c, a.to);
        if (c.disk.has(toKey) && toKey !== this.key(c, a.from)) return;
        c.disk.delete(this.key(c, a.from));
        c.disk.set(toKey, { path: a.to, hash: from.hash });
        if (a.watched) this.feed(a.c, { type: "localRename", from: from.path, to: a.to }, null);
        return;
      }
      case "sync":
        this.feed(a.c, { type: "sync", scan: this.scan(this.clients[a.c]!) }, a.crashAt);
        return;
      case "deliver":
        this.deliver(a.k, a.crashAt);
        return;
      case "drop": {
        if (this.net.length === 0) return;
        const [m] = this.net.splice(a.k % this.net.length, 1);
        // A lost request or response looks like a timeout to the client.
        if (m) {
          const requestId = m.to === "server" ? m.requestId : m.event.requestId;
          this.feed(m.client, { type: "networkError", requestId }, null);
        }
        return;
      }
      case "dup":
        if (this.net.length > 0) this.net.push(this.net[a.k % this.net.length]!);
        return;
      case "crash":
        this.crash(a.c);
        return;
    }
  }

  private scan(c: SimClient) {
    return [...c.disk.values()].map((f) => ({ path: f.path, hash: f.hash, size: 1, mtime: 0 }));
  }

  private crash(i: number): void {
    const c = this.clients[i]!;
    c.state = {
      config: c.state.config,
      durable: JSON.parse(JSON.stringify(c.persisted)) as Durable,
      vol: { phase: "idle", requestId: null, stopped: null },
    };
    c.queue = [];
  }

  /** Runs an event and every event its effects cause; `crashAt` = crash after that many effects. */
  private feed(i: number, event: ClientEvent, crashAt: number | null): void {
    const c = this.clients[i]!;
    c.queue.push(event);
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
      case "write": {
        const k = this.key(c, fx.path);
        const cur = c.disk.get(k)?.hash ?? null;
        if (cur !== fx.expect) {
          c.queue.push({ type: "written", fileId: fx.fileId, ok: false });
          return;
        }
        if (cur !== null && !this.store.hasContent(cur))
          this.violations.push(`client ${i} overwrote content the server doesn't have: ${fx.path}`);
        c.disk.set(k, { path: c.disk.get(k)?.path ?? fx.path, hash: fx.hash });
        c.queue.push({ type: "written", fileId: fx.fileId, ok: true });
        return;
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
        return;
      }
      case "trash": {
        const k = this.key(c, fx.path);
        const cur = c.disk.get(k)?.hash ?? null;
        if (cur !== fx.expect) {
          c.queue.push({ type: "trashed", fileId: fx.fileId, ok: false });
          return;
        }
        if (!this.store.hasContent(fx.expect))
          this.violations.push(`client ${i} trashed content the server doesn't have: ${fx.path}`);
        c.disk.delete(k);
        c.queue.push({ type: "trashed", fileId: fx.fileId, ok: true });
        return;
      }
      case "ack":
        this.store.cursors.set(c.deviceId, fx.seq);
        return;
      case "notify":
        return;
    }
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
      const res = this.store.commit(m.ops, deviceId);
      for (const problem of checkInvariants(this.store)) this.violations.push(`server: ${problem}`);
      event = {
        type: "pushResult",
        requestId: m.requestId,
        results: res.results as OpResult[],
        head: res.head,
      };
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

  /** No more faults: sync everyone until nothing moves. Returns false if it never settles. */
  settle(maxRounds = 40): boolean {
    for (let round = 0; round < maxRounds; round++) {
      for (let i = 0; i < this.clients.length; i++) {
        this.act({ t: "sync", c: i, crashAt: null });
        while (this.net.length > 0) this.deliver(0, null);
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
      const probe = step(s, { type: "sync", scan: this.scan(c) }, { newId: () => "probe" });
      return probe.effects.every((fx) => fx.type === "persist" || fx.type === "pull");
    });
  }

  /** Convergence and "nothing lost" (spec §4.1–2), as readable problems. */
  check(): string[] {
    const out = [...this.violations];
    const live = [...this.store.files.values()].filter((f) => f.kind === "file" && !f.deleted);
    this.clients.forEach((c, i) => {
      const index = c.state.durable.index;
      for (const f of live) {
        const e = index[f.fileId];
        if (!e) {
          out.push(`client ${i} doesn't know ${f.path}`);
          continue;
        }
        if (e.unavailable || e.conflictId) continue;
        const occupant = Object.values(index).find(
          (o) => o !== e && o.conflictId && this.key(c, o.path) === this.key(c, f.path),
        );
        if (occupant) continue; // our conflicted copy keeps the path on this device (03 §9.2)
        const onDisk = c.disk.get(this.key(c, f.path));
        if (!onDisk || onDisk.hash !== f.headHash || onDisk.path !== f.path)
          out.push(
            `client ${i}: ${f.path} is ${onDisk ? `${onDisk.path}=${onDisk.hash}` : "missing"}, server has ${f.headHash}`,
          );
      }
      for (const d of c.disk.values()) {
        const e = Object.values(index).find(
          (x) => x.localHash !== null && this.key(c, x.path) === this.key(c, d.path),
        );
        if (!e) {
          out.push(`client ${i}: ${d.path} on disk but not tracked`);
          continue;
        }
        if (e.conflictId) continue; // local edits after a conflict stay local until it's resolved (M3)
        if (!this.store.hasContent(d.hash))
          out.push(`client ${i}: content of ${d.path} never reached the server`);
        if (!e.unavailable && !live.some((f) => f.fileId === e.fileId))
          out.push(`client ${i}: ${d.path} is not a live file on the server`);
      }
    });
    return out;
  }
}
