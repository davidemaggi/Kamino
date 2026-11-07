// R-4 spike: a monotonically increasing event feed with bounded history, so a
// reconnecting client can ask "everything after seq N" and measure the catch-up.

export interface FeedEvent {
  seq: number;
  ts: number;
}

export interface CatchUp {
  /** Events strictly after the requested seq, oldest first. */
  events: FeedEvent[];
  /** True when the requested seq is older than the retained history (events were lost). */
  truncated: boolean;
}

export class EventFeed {
  readonly #history: FeedEvent[] = [];
  #seq = 0;

  constructor(
    private readonly capacity = 100_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get lastSeq(): number {
    return this.#seq;
  }

  next(): FeedEvent {
    this.#seq += 1;
    const event = { seq: this.#seq, ts: this.now() };
    this.#history.push(event);
    if (this.#history.length > this.capacity) this.#history.shift();
    return event;
  }

  since(seq: number): CatchUp {
    const oldest = this.#history[0];
    const truncated = oldest !== undefined && seq < oldest.seq - 1;
    return { events: this.#history.filter((e) => e.seq > seq), truncated };
  }
}
