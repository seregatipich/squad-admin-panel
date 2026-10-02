import { type A2sFailureReason, probeA2S } from '../a2s.js';
import type { SupervisorOptions, Target } from './types.js';

/** Consecutive failed probes before the cache says "query unavailable". */
const FAILURES_BEFORE_UNAVAILABLE = 3;
/** How long one query waits for a reply. */
const DEFAULT_QUERY_TIMEOUT_MS = 2000;
/** Lifetime of the cached answer; the full poll (30 s) refreshes it. */
const A2S_STATUS_TTL_SECONDS = 90;

/**
 * The best-effort A2S query of one server, cached under `a2s:status:<serverId>`.
 *
 * A successful query stores what the server answered, `visible` included. A
 * run of failures stores `visible: null` plus the reason and the time of the
 * last success: no answer on the query port says nothing about the server's
 * visibility (the game process may simply not service that socket, #127), and
 * the panel must not present it as a hidden or offline server.
 */
export class A2sProbe {
  private consecutiveFails = 0;
  private lastSuccessAt: string | null = null;

  constructor(
    private readonly target: Target,
    private readonly opts: SupervisorOptions,
    private readonly timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
  ) {}

  /** Never throws: A2S must not disrupt RCON polling. */
  async probe(): Promise<void> {
    try {
      const startedAt = Date.now();
      const outcome = await probeA2S(this.target.host, this.target.queryPort, {
        timeoutMs: this.timeoutMs,
        addressPolicy: this.target.refuseRestrictedAddresses
          ? { privateHostAllowlist: this.target.privateHostAllowlist ?? null }
          : undefined,
      });
      if (outcome.ok) {
        const queriedAt = new Date().toISOString();
        this.consecutiveFails = 0;
        this.lastSuccessAt = queriedAt;
        await this.write({
          visible: outcome.info.visible,
          server_name: outcome.info.serverName,
          map: outcome.info.map,
          players: outcome.info.players,
          max_players: outcome.info.maxPlayers,
          latency_ms: Date.now() - startedAt,
          queried_at: queriedAt,
          last_success_at: queriedAt,
        });
        return;
      }
      this.consecutiveFails++;
      if (this.consecutiveFails >= FAILURES_BEFORE_UNAVAILABLE) {
        await this.writeUnavailable(outcome.reason);
      }
    } catch {
      // A2S is best-effort; don't disrupt RCON polling
    }
  }

  private async writeUnavailable(reason: A2sFailureReason): Promise<void> {
    this.lastSuccessAt ??= await this.readPriorSuccess();
    await this.write({
      visible: null,
      reason,
      queried_at: new Date().toISOString(),
      last_success_at: this.lastSuccessAt,
    });
  }

  /** The last success a previous worker process cached, if its entry is still there. */
  private async readPriorSuccess(): Promise<string | null> {
    try {
      const raw = await this.opts.redis.get(this.key);
      if (!raw) return null;
      const prior = JSON.parse(raw) as {
        visible?: boolean | null;
        queried_at?: string;
        last_success_at?: string | null;
      };
      if (typeof prior.last_success_at === 'string') return prior.last_success_at;
      return typeof prior.visible === 'boolean' && typeof prior.queried_at === 'string'
        ? prior.queried_at
        : null;
    } catch {
      return null;
    }
  }

  private get key(): string {
    return `a2s:status:${this.target.serverId}`;
  }

  private async write(body: Record<string, unknown>): Promise<void> {
    await this.opts.redis.set(this.key, JSON.stringify(body), 'EX', A2S_STATUS_TTL_SECONDS);
  }
}
