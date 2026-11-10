import type { ServerMessage } from "@kamino/protocol";

/** One live socket of a device, as the hub sees it. */
export interface Conn {
  readonly vaultId: string;
  readonly deviceId: string;
  readonly userId: string;
  /** New journal entries may exist: read them (coalesced by the socket). */
  wake(): void;
  close(code: number, message?: ServerMessage): void;
}

/** Spec §5: older sockets of the same device are closed beyond this. */
export const MAX_SOCKETS_PER_DEVICE = 5;
export const CLOSE_REPLACED = 4409;

/** Live connections per vault and per device, in memory (02 §110). */
export class Hub {
  private readonly byVault = new Map<string, Set<Conn>>();
  private readonly byDevice = new Map<string, Conn[]>();

  add(c: Conn): void {
    const vault = this.byVault.get(c.vaultId) ?? new Set<Conn>();
    vault.add(c);
    this.byVault.set(c.vaultId, vault);
    const mine = this.byDevice.get(c.deviceId) ?? [];
    mine.push(c);
    this.byDevice.set(c.deviceId, mine);
    // `remove` replaces the device's array: re-read it on every round.
    for (
      let list = this.byDevice.get(c.deviceId) ?? [];
      list.length > MAX_SOCKETS_PER_DEVICE;
      list = this.byDevice.get(c.deviceId) ?? []
    ) {
      const oldest = list[0]!;
      this.remove(oldest);
      oldest.close(CLOSE_REPLACED);
    }
  }

  remove(c: Conn): void {
    const vault = this.byVault.get(c.vaultId);
    vault?.delete(c);
    if (vault?.size === 0) this.byVault.delete(c.vaultId);
    const mine = this.byDevice.get(c.deviceId)?.filter((x) => x !== c) ?? [];
    if (mine.length) this.byDevice.set(c.deviceId, mine);
    else this.byDevice.delete(c.deviceId);
  }

  notify(vaultId: string): void {
    for (const c of this.byVault.get(vaultId) ?? []) c.wake();
  }

  /** After a dropped LISTEN connection a notification may be lost: everyone re-reads. */
  wakeAll(): void {
    for (const set of this.byVault.values()) for (const c of set) c.wake();
  }

  closeDevice(deviceId: string, message: ServerMessage, code = 4403): void {
    for (const c of [...(this.byDevice.get(deviceId) ?? [])]) {
      this.remove(c);
      c.close(code, message);
    }
  }

  closeUser(userId: string, message: ServerMessage, code = 4403): void {
    for (const set of [...this.byVault.values()])
      for (const c of [...set])
        if (c.userId === userId) {
          this.remove(c);
          c.close(code, message);
        }
  }

  size(): number {
    let n = 0;
    for (const set of this.byVault.values()) n += set.size;
    return n;
  }
}
