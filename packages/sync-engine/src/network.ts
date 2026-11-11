/**
 * The network as the plugin sees it (S-08, spec §6.7). `ask` = unknown (iOS): the user is asked
 * whether large files may use it.
 */
export interface Network {
  kind(): "free" | "metered" | "ask";
  /** true = large files may go now (the plugin remembers "don't ask again this session"). */
  ask(): Promise<boolean>;
}
