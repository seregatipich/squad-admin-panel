import type { RconRefreshScope } from '@squad/shared-config';
import { PerServerSupervisor } from './supervisor/per-server.js';
import type { SupervisorOptions, Target } from './supervisor/types.js';

export {
  DEFAULT_INFO_INTERVAL_MS,
  DEFAULT_ROSTER_INTERVAL_MS,
} from './supervisor/server-poller.js';
export type { SupervisorOptions, Target } from './supervisor/types.js';

/** True when the parameters that pick the TCP/UDP endpoint or the AUTH secret differ. */
function connectionChanged(a: Target, b: Target): boolean {
  return (
    a.host !== b.host ||
    a.port !== b.port ||
    a.password !== b.password ||
    a.queryPort !== b.queryPort
  );
}

export class RconSupervisor {
  private readonly targets = new Map<string, Target>();
  private readonly supervisors = new Map<string, PerServerSupervisor>();

  constructor(private readonly opts: SupervisorOptions) {}

  async reconcile(targets: Target[]): Promise<void> {
    const incoming = new Map(targets.map((t) => [t.serverId, t]));
    const added: string[] = [];
    const removed: string[] = [];
    const redialed: string[] = [];
    for (const [id, t] of incoming) {
      const previous = this.targets.get(id);
      if (this.supervisors.has(id) && previous && connectionChanged(previous, t)) {
        // The operator repointed the server (host/port/password edit on an
        // external server, or a rotated Rcon.cfg). The running supervisor
        // holds the old dial parameters, so replace it rather than let it
        // retry a dead endpoint until the next worker restart.
        // Unregister before awaiting: a reconcile that overlaps this one must
        // not find the old supervisor still registered and replace it too,
        // which would orphan whichever supervisor was created in between.
        const stale = this.supervisors.get(id);
        this.supervisors.delete(id);
        await stale?.stop();
        redialed.push(id);
      }
      if (!this.supervisors.has(id)) {
        const sup = new PerServerSupervisor(t, this.opts);
        this.supervisors.set(id, sup);
        this.targets.set(id, t);
        if (!redialed.includes(id)) added.push(id);
        sup.start();
      } else {
        this.targets.set(id, t);
      }
    }
    for (const id of Array.from(this.supervisors.keys())) {
      if (!incoming.has(id)) {
        const stale = this.supervisors.get(id);
        this.supervisors.delete(id);
        this.targets.delete(id);
        await stale?.stop();
        removed.push(id);
      }
    }
    if ((added.length || removed.length || redialed.length) && this.opts.diag) {
      const total = this.supervisors.size;
      this.opts.diag
        .emit({
          component: 'worker-rcon',
          kind: 'rcon.targets.changed',
          severity: 'info',
          message: `targets changed: +${added.length}, -${removed.length}, ~${redialed.length}, total=${total}`,
          payload: { added, removed, redialed, total },
        })
        .catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    for (const sup of this.supervisors.values()) await sup.stop();
    this.supervisors.clear();
    this.targets.clear();
  }

  size(): number {
    return this.supervisors.size;
  }

  /**
   * Routes a refresh hint (see `RCON_REFRESH_CHANNEL`) to the server's
   * supervisor. `reason` is the log event that caused it; `match.started` and
   * `match.ended` also reset the server's squad history. Returns false when
   * this worker does not poll that server (it is stopped, or its hint raced a
   * reconcile) and the hint is dropped.
   */
  hint(serverId: string, scopes: RconRefreshScope[], reason?: string): boolean {
    const sup = this.supervisors.get(serverId);
    if (!sup) return false;
    sup.requestRefresh(scopes, reason);
    return true;
  }
}
