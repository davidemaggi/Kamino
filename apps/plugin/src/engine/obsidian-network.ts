import type { Network } from "@kamino/sync-engine";

export interface NetworkOptions {
  isMobile: boolean;
  isIos: boolean;
  /** `navigator.connection` where the platform has it (Android). */
  connection: () => { type?: string; saveData?: boolean } | undefined;
  /** The metered-network question (iOS): proceed now, and "don't ask again this session". */
  confirm: () => Promise<{ ok: boolean; dontAsk: boolean }>;
}

/**
 * S-08 on Obsidian: desktop is never metered; Android reads `navigator.connection`
 * (cellular or data saver = metered; unknown = free, R-2 not run yet); iOS can't tell, so the
 * user is asked, with "don't ask again" for the rest of the session.
 */
export class ObsidianNetwork implements Network {
  private dontAsk = false;

  constructor(private readonly o: NetworkOptions) {}

  kind(): "free" | "metered" | "ask" {
    if (!this.o.isMobile) return "free";
    if (this.o.isIos) return this.dontAsk ? "free" : "ask";
    const c = this.o.connection();
    if (!c) return "free";
    return c.saveData || c.type === "cellular" ? "metered" : "free";
  }

  async ask(): Promise<boolean> {
    const r = await this.o.confirm();
    if (r.ok && r.dontAsk) this.dontAsk = true;
    return r.ok;
  }
}
