import type { Diag } from '@squad/diag';

export interface TailHandle {
  abort(): void;
}

export type ManagedTailFactory = (serverId: string, beaconPort: number) => TailHandle;

export interface TailWanted {
  serverId: string;
  beaconPort: number;
}

export class TailManager {
  private readonly aborters = new Map<string, () => void>();

  constructor(
    private readonly factory: ManagedTailFactory,
    private readonly diag?: Diag,
  ) {}

  reconcile(wanted: TailWanted[]): { added: string[]; removed: string[]; total: number } {
    const incoming = new Map(wanted.map((t) => [t.serverId, t]));
    const added: string[] = [];
    const removed: string[] = [];
    for (const [serverId, t] of incoming) {
      if (!this.aborters.has(serverId)) {
        const handle = this.factory(serverId, t.beaconPort);
        this.aborters.set(serverId, () => handle.abort());
        added.push(serverId);
      }
    }
    for (const id of Array.from(this.aborters.keys())) {
      if (!incoming.has(id)) {
        this.aborters.get(id)?.();
        this.aborters.delete(id);
        removed.push(id);
      }
    }
    const total = this.aborters.size;
    if ((added.length || removed.length) && this.diag) {
      this.diag
        .emit({
          component: 'worker-log-ingest',
          kind: 'tails.changed',
          severity: 'info',
          message: `tails changed: +${added.length}, -${removed.length}, total=${total}`,
          payload: { added, removed, total },
        })
        .catch(() => undefined);
    }
    return { added, removed, total };
  }

  size(): number {
    return this.aborters.size;
  }

  stopAll(): void {
    for (const abort of this.aborters.values()) abort();
    this.aborters.clear();
  }
}
