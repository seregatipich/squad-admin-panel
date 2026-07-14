import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import teamkillsRoutes from '../src/routes/teamkills.js';

function buildApp(opts: {
  combatView?: boolean;
  execute?: ReturnType<typeof vi.fn>;
  playerId?: string;
}) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('db', { execute: opts.execute ?? vi.fn().mockResolvedValue([]) });
  app.addHook('preHandler', async (req) => {
    req.user = {
      playerId: opts.playerId ?? 'viewer-player',
      permissions: {
        combatView: opts.combatView ?? true,
      },
    } as typeof req.user;
  });
  return app;
}

describe('teamkillsRoutes', () => {
  it('normalizes the teamkill summary response from database rows', async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        player_id: 'player-alpha',
        current_name: 'Alpha TK',
        steam_id64: 76561198200000001n,
        eos_id: null,
        tk_total: '11',
        tk_7d: '9',
        tk_30d: '10',
        victim_of_tk_total: '2',
        last_tk_at: new Date('2026-07-07T18:30:00.000Z'),
        moderation_total: 3n,
        last_moderation_at: '2026-07-06T10:00:00.000Z',
        last_moderation_type: 'warn',
      },
    ]);
    const app = buildApp({ execute });
    await app.register(teamkillsRoutes);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/teamkills?sort=tk_7d&limit=10',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(new Date(body.generated_at).getTime()).not.toBeNaN();
    expect(body.rows).toEqual([
      {
        player_id: 'player-alpha',
        current_name: 'Alpha TK',
        steam_id64: '76561198200000001',
        eos_id: null,
        tk_total: 11,
        tk_7d: 9,
        tk_30d: 10,
        victim_of_tk_total: 2,
        last_tk_at: '2026-07-07T18:30:00.000Z',
        moderation_total: 3,
        last_moderation_at: '2026-07-06T10:00:00.000Z',
        last_moderation_type: 'warn',
      },
    ]);
  });

  it('normalizes a zero-moderation offender to null moderation fields', async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        player_id: 'player-charlie',
        current_name: 'Charlie TK',
        steam_id64: null,
        eos_id: 'eos-1',
        tk_total: 3,
        tk_7d: 2,
        tk_30d: 3,
        victim_of_tk_total: 0,
        last_tk_at: new Date('2026-07-07T18:30:00.000Z'),
        moderation_total: 0,
        last_moderation_at: null,
        last_moderation_type: null,
      },
    ]);
    const app = buildApp({ execute });
    await app.register(teamkillsRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/v1/moderation/teamkills' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows[0]).toMatchObject({
      moderation_total: 0,
      last_moderation_at: null,
      last_moderation_type: null,
    });
  });

  it('uses the combat view permission for moderation routes', async () => {
    const app = buildApp({ combatView: false });
    await app.register(teamkillsRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/v1/moderation/teamkills' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });
});
