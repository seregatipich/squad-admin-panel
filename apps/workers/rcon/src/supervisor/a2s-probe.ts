import { queryA2S } from '../a2s.js';
import type { SupervisorOptions, Target } from './types.js';

/** The best-effort A2S query of one server, cached under `a2s:status:<serverId>`. */
export class A2sProbe {
  private consecutiveA2SFails = 0;

  constructor(
    private readonly target: Target,
    private readonly opts: SupervisorOptions,
  ) {}

  /** Never throws: A2S must not disrupt RCON polling. */
  async probe(): Promise<void> {
    try {
      const a2sStart = Date.now();
      const a2sResult = await queryA2S(this.target.host, this.target.queryPort, 2000);
      const a2sKey = `a2s:status:${this.target.serverId}`;
      if (a2sResult) {
        await this.opts.redis.set(
          a2sKey,
          JSON.stringify({
            visible: a2sResult.visible,
            server_name: a2sResult.serverName,
            map: a2sResult.map,
            players: a2sResult.players,
            max_players: a2sResult.maxPlayers,
            latency_ms: Date.now() - a2sStart,
            queried_at: new Date().toISOString(),
          }),
          'EX',
          90,
        );
        this.consecutiveA2SFails = 0;
      } else {
        this.consecutiveA2SFails++;
        if (this.consecutiveA2SFails >= 3) {
          await this.opts.redis.set(
            a2sKey,
            JSON.stringify({
              visible: false,
              reason: 'timeout',
              queried_at: new Date().toISOString(),
            }),
            'EX',
            90,
          );
        }
      }
    } catch {
      // A2S is best-effort; don't disrupt RCON polling
    }
  }
}
