// Smoke test against a running test server: pnpm smoke [http://localhost:8787]
// Best with a fast ticker (pnpm server --interval 20) to stress the reconnect race.
// Uploads 10 MiB of random bytes in 4 MiB chunks and checks the SHA-256, then
// connects to the WebSocket, disconnects, reconnects and checks the catch-up.
import { createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";

const base = process.argv[2] ?? "http://localhost:8787";
const CHUNK = 4 * 1024 * 1024;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function smokeUpload(): Promise<void> {
  const payload = randomBytes(10 * 1024 * 1024 + 123);
  const expected = createHash("sha256").update(payload).digest("hex");
  const { uploadId } = await json<{ uploadId: string }>(
    await fetch(`${base}/upload/start`, {
      method: "POST",
      body: JSON.stringify({ name: "smoke.bin", size: payload.byteLength }),
    }),
  );
  for (let i = 0, off = 0; off < payload.byteLength; i++, off += CHUNK) {
    await json(
      await fetch(`${base}/upload/${uploadId}/chunk/${i}`, {
        method: "PUT",
        body: payload.subarray(off, off + CHUNK),
      }),
    );
  }
  const done = await json<{ sha256: string; chunks: number; sizeMatches: boolean }>(
    await fetch(`${base}/upload/${uploadId}/finish`, { method: "POST" }),
  );
  if (done.sha256 !== expected || done.chunks !== 3 || !done.sizeMatches) {
    throw new Error(`upload mismatch: ${JSON.stringify(done)} expected ${expected}`);
  }
  console.log(`upload OK: 3 chunks, sha256 ${done.sha256}`);
}

interface Msg {
  type: string;
  seq?: number;
  events?: { seq: number }[];
  truncated?: boolean;
}

interface Session {
  /** Every seq received, in arrival order: catch-up events first, then live ones. */
  seqs: number[];
  caught: number;
  liveBeforeCatchUp: number;
  last: number;
}

/** Strict client: does not dedupe, so any live-before-catch-up race shows up as a non-contiguous sequence. */
function connect(lastSeq: number | null, wantLive: number): Promise<Session> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`);
    const seqs: number[] = [];
    let caughtUp = false;
    let caught = 0;
    let live = 0;
    let liveBeforeCatchUp = 0;
    let last = lastSeq ?? 0;
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", lastSeq })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Msg & { to?: number };
      if (msg.type === "catchup") {
        caughtUp = true;
        for (const e of msg.events ?? []) seqs.push(e.seq);
        caught = msg.events?.length ?? 0;
        last = seqs[seqs.length - 1] ?? msg.to ?? last;
      } else if (msg.type === "event" && msg.seq !== undefined) {
        if (!caughtUp) liveBeforeCatchUp++;
        seqs.push(msg.seq);
        last = msg.seq;
        if (++live >= wantLive) {
          ws.close();
          resolve({ seqs, caught, liveBeforeCatchUp, last });
        }
      }
    });
    ws.on("error", reject);
  });
}

function assertContiguous(label: string, after: number | null, s: Session): void {
  const ok =
    s.liveBeforeCatchUp === 0 &&
    s.seqs.every((seq, i) => (i === 0 ? after === null || seq === after + 1 : seq === s.seqs[i - 1]! + 1));
  if (!ok) throw new Error(`${label}: not contiguous after ${after}: ${JSON.stringify(s)}`);
}

async function smokeWebSocket(): Promise<void> {
  const first = await connect(null, 5);
  assertContiguous("first session", null, first);
  console.log(`ws first session: last seq ${first.last}`);
  // Reconnect repeatedly while the server ticker keeps running (run the server with a
  // short --interval, e.g. 20 ms, to make the live/catch-up race likely if it existed).
  let last = first.last;
  let caughtTotal = 0;
  for (let round = 0; round < 20; round++) {
    await new Promise((r) => setTimeout(r, 100 + (round % 5) * 37));
    const s = await connect(last, 3);
    assertContiguous(`reconnect #${round + 1}`, last, s);
    caughtTotal += s.caught;
    last = s.last;
  }
  if (caughtTotal === 0) throw new Error("no event was ever caught up");
  console.log(`ws catch-up OK: 20 reconnects, ${caughtTotal} events caught up, all contiguous, last seq ${last}`);
}

await smokeUpload();
await smokeWebSocket();
console.log("SMOKE OK");
