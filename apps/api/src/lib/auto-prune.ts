import type { FastifyInstance } from 'fastify';
import { writeAuditEntry } from './audit.js';

/**
 * Fire-and-forget docker prune. Used on every server soft-delete so the
 * operator never has to remember to free disk afterwards. Runs through a
 * dedicated bridge client so the long stream doesn't share the API's
 * shared multiplex with other in-flight requests.
 *
 * Errors are logged but never propagated — the caller's response should
 * NOT depend on prune success. The audit row is still written
 * (status_code reflects success or failure).
 */
export function fireAutoPrune(
  app: FastifyInstance,
  reason: string,
  actorSteamId64: bigint | null,
  actorIp: string | null,
): void {
  setImmediate(async () => {
    const startedAt = Date.now();
    let reclaimed = 0;
    let reclaimedHuman = '';
    let exitCode = -1;
    let errorMsg: string | null = null;
    try {
      const client = app.makeBridgeClient();
      try {
        const result = await client.dockerPrune();
        exitCode = result.exit_code;
        reclaimed = result.reclaimed_bytes;
        reclaimedHuman = result.reclaimed_human;
        app.log.info(
          {
            reason,
            reclaimed_bytes: reclaimed,
            reclaimed_human: reclaimedHuman,
            duration_ms: Date.now() - startedAt,
          },
          'auto docker prune',
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch (err) {
      errorMsg = (err as Error).message;
      app.log.warn({ reason, err: errorMsg }, 'auto docker prune failed');
    }
    try {
      await writeAuditEntry(app.db, {
        actor: actorSteamId64
          ? { kind: 'steam', steamId64: actorSteamId64, tokenId: null }
          : { kind: 'system', label: 'auto-prune' },
        actorIp,
        actionType: 'host.docker_prune',
        targetType: 'host',
        targetId: 'localhost',
        context: {
          reason,
          reclaimed_bytes: reclaimed,
          reclaimed_human: reclaimedHuman,
          exit_code: exitCode,
          duration_ms: Date.now() - startedAt,
          error: errorMsg,
        },
        statusCode: errorMsg ? 502 : 200,
      });
    } catch (auditErr) {
      app.log.warn(
        { err: (auditErr as Error).message },
        'auto-prune audit append failed (non-fatal)',
      );
    }
  });
}
