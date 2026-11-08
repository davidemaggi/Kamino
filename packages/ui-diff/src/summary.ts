import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";

export interface DiffSummary {
  /** Number of changed line blocks. */
  changes: number;
}

export function diffSummary(mine: string, incoming: string): DiffSummary {
  const chunks = Chunk.build(Text.of(mine.split("\n")), Text.of(incoming.split("\n")));
  return { changes: chunks.length };
}
