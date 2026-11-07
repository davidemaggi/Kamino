// Smoke test against a running test server: pnpm smoke [http://localhost:8787]
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

function connect(
  lastSeq: number | null,
  wantEvents: number,
): Promise<{ last: number; caught: number[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`);
    let last = lastSeq ?? 0;
    let seen = 0;
    const caught: number[] = [];
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", lastSeq })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Msg;
      if (msg.type === "catchup") {
        for (const e of msg.events ?? []) caught.push(e.seq);
        if (caught.length) last = caught[caught.length - 1]!;
      } else if (msg.type === "event" && msg.seq !== undefined) {
        if (msg.seq <= last) return;
        last = msg.seq;
        if (++seen >= wantEvents) {
          ws.close();
          resolve({ last, caught });
        }
      }
    });
    ws.on("error", reject);
  });
}

async function smokeWebSocket(): Promise<void> {
  const first = await connect(null, 2);
  console.log(`ws first session: last seq ${first.last}`);
  await new Promise((r) => setTimeout(r, 2500));
  const second = await connect(first.last, 1);
  const contiguous = second.caught.every((s, i) => s === first.last + 1 + i);
  if (second.caught.length < 2 || !contiguous) {
    throw new Error(`catch-up wrong: ${JSON.stringify(second.caught)} after ${first.last}`);
  }
  console.log(`ws catch-up OK: ${second.caught.length} events (${second.caught.join(",")})`);
}

await smokeUpload();
await smokeWebSocket();
console.log("SMOKE OK");
