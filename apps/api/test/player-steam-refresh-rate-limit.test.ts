import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, describe, expect, it } from 'vitest';
import playerSteamRefreshRoutes, {
  STEAM_REFRESH_RATE_LIMIT_PER_MINUTE,
} from '../src/routes/player-steam-refresh.js';

/**
 * Audit #71 (#242): POST /players/:id/steam-refresh spends Steam Web API quota
 * on every uncached player, so it carries its own per-user limit on top of the
 * global 1200/min. The real `@fastify/rate-limit` plugin is registered around
 * the real route; the database is a stub that knows no player, so every
 * admitted request ends in a cheap 404 without touching Steam.
 */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const noPlayer = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  };
  app.decorate('db', noPlayer as never);
  app.addHook('onRequest', async (req) => {
    const playerId = req.headers['x-test-player'];
    if (typeof playerId === 'string') {
      (req as { user?: unknown }).user = { playerId };
    }
  });
  await app.register(rateLimit, { max: 1200, timeWindow: '1 minute' });
  await app.register(playerSteamRefreshRoutes);
  await app.ready();
  return app;
}

describe('POST /api/v1/players/:playerId/steam-refresh rate limit (#242)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('answers 429 once one user exceeds the per-minute budget, independently per user', async () => {
    app = await buildApp();
    const refresh = (player: string) =>
      app!.inject({
        method: 'POST',
        url: `/api/v1/players/${uuidv7()}/steam-refresh`,
        headers: { 'x-test-player': player },
      });

    expect(STEAM_REFRESH_RATE_LIMIT_PER_MINUTE).toBeLessThanOrEqual(20);
    for (let i = 0; i < STEAM_REFRESH_RATE_LIMIT_PER_MINUTE; i += 1) {
      expect((await refresh('admin-a')).statusCode).toBe(404);
    }
    expect((await refresh('admin-a')).statusCode).toBe(429);
    expect((await refresh('admin-b')).statusCode).toBe(404);
  });
});
