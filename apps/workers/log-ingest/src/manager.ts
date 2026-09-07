import type { Diag } from '@squad/diag';

export interface TailHandle {
  abort(): void;
}

/** Panel-hosted container: `docker logs -f squad-<id>` through the host bridge. */
export interface ContainerTailSource {
  kind: 'container';
}

/** External server: `tail -F` of `SquadGame.log` over SSH on the game host. */
export interface SshTailSource {
  kind: 'ssh';
  host: string;
  port: number;
  username: string;
  /** Decrypted PEM private key; never logged or included in `sourceKey`. */
  privateKey: string;
  logPath: string;
  hostKeyFingerprint: string | null;
  /** Bumps when the stored key is regenerated so a live tail redials with the new one. */
  keyVersion: number;
}

export type TailSource = ContainerTailSource | SshTailSource;

export interface TailWanted {
  serverId: string;
  beaconPort: number;
  source: TailSource;
}

export type ManagedTailFactory = (wanted: TailWanted) => TailHandle;

/**
 * Identity of a tail's dial parameters. Two `TailWanted` with the same key
 * describe the same stream; a different key for an already-running server
 * means the operator repointed it (host/path/user/port/key) and the running
 * tail must be replaced. The private key material itself stays out of the
 * string — only its version is compared.
 */
export function tailSourceKey(wanted: TailWanted): string {
  const s = wanted.source;
  if (s.kind === 'container') return `container:${wanted.beaconPort}`;
  // The pinned host-key fingerprint is deliberately not part of the key: the
  // tail records it on first use, and that write must not trigger a redial.
  return ['ssh', wanted.beaconPort, s.host, s.port, s.username, s.logPath, s.keyVersion].join('|');
}

export class TailManager {
  private readonly aborters = new Map<string, () => void>();
  private readonly keys = new Map<string, string>();

  constructor(
    private readonly factory: ManagedTailFactory,
    private readonly diag?: Diag,
  ) {}

  reconcile(wanted: TailWanted[]): {
    added: string[];
    removed: string[];
    replaced: string[];
    total: number;
  } {
    const incoming = new Map(wanted.map((t) => [t.serverId, t]));
    const added: string[] = [];
    const removed: string[] = [];
    const replaced: string[] = [];
    for (const [serverId, t] of incoming) {
      const key = tailSourceKey(t);
      const running = this.aborters.get(serverId);
      if (running && this.keys.get(serverId) !== key) {
        running();
        this.aborters.delete(serverId);
        replaced.push(serverId);
      }
      if (!this.aborters.has(serverId)) {
        const handle = this.factory(t);
        this.aborters.set(serverId, () => handle.abort());
        this.keys.set(serverId, key);
        if (!replaced.includes(serverId)) added.push(serverId);
      }
    }
    for (const id of Array.from(this.aborters.keys())) {
      if (!incoming.has(id)) {
        this.aborters.get(id)?.();
        this.aborters.delete(id);
        this.keys.delete(id);
        removed.push(id);
      }
    }
    const total = this.aborters.size;
    if ((added.length || removed.length || replaced.length) && this.diag) {
      this.diag
        .emit({
          component: 'worker-log-ingest',
          kind: 'tails.changed',
          severity: 'info',
          message: `tails changed: +${added.length}, -${removed.length}, ~${replaced.length}, total=${total}`,
          payload: { added, removed, replaced, total },
        })
        .catch(() => undefined);
    }
    return { added, removed, replaced, total };
  }

  size(): number {
    return this.aborters.size;
  }

  stopAll(): void {
    for (const abort of this.aborters.values()) abort();
    this.aborters.clear();
    this.keys.clear();
  }
}
