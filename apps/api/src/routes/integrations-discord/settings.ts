import { DISCORD_INTEGRATION_SINGLETON_ID, discordIntegration } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { encrypt, serialize } from '../../lib/crypto.js';
import { BOT_TOKEN_MASK } from '../../lib/discord.js';
import { INTEGRATION_PERMISSION } from '../../lib/integrations-discord/common.js';

const guildIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,32}$/, 'invalid guild id');

const putIntegrationBody = z.object({
  guild_id: guildIdSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  bot_token: z.string().trim().min(1).max(120).nullable().optional(),
});

interface IntegrationRowLike {
  guildId: string | null;
  botTokenEncrypted: Buffer | null;
  enabled: boolean;
  updatedAt: Date;
}

function integrationView(row: IntegrationRowLike | null) {
  if (!row) {
    return {
      guild_id: null,
      enabled: false,
      bot_token_configured: false,
      bot_token_mask: null,
      updated_at: null,
    };
  }
  const configured = row.botTokenEncrypted != null;
  return {
    guild_id: row.guildId,
    enabled: row.enabled,
    bot_token_configured: configured,
    bot_token_mask: configured ? BOT_TOKEN_MASK : null,
    updated_at: row.updatedAt.toISOString(),
  };
}

/** Discord bot integration settings. */
const discordSettingsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/integrations/discord',
    { config: { permissions: [INTEGRATION_PERMISSION], audit: false } },
    async () => {
      const rows = await app.db
        .select()
        .from(discordIntegration)
        .where(eq(discordIntegration.id, DISCORD_INTEGRATION_SINGLETON_ID))
        .limit(1);
      return integrationView(rows[0] ?? null);
    },
  );

  fast.put(
    '/api/v1/integrations/discord',
    {
      schema: { body: putIntegrationBody },
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: { action: 'integration.discord.update', resource: 'discord_integration' },
      },
    },
    async (req) => {
      const botToken = req.body.bot_token;
      const encryptedToken =
        typeof botToken === 'string' ? serialize(encrypt(app.encryptionKey, botToken)) : null;

      // Read-modify-write of the singleton under a row lock: the idempotent
      // insert makes the row exist (and waits for a concurrent creator), then
      // FOR UPDATE serialises concurrent PUTs so neither 500s on the primary
      // key nor overwrites the other's fields from a stale read.
      const { created, existing, updated } = await app.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(discordIntegration)
          .values({ id: DISCORD_INTEGRATION_SINGLETON_ID })
          .onConflictDoNothing()
          .returning({ id: discordIntegration.id });
        const [current] = await tx
          .select()
          .from(discordIntegration)
          .where(eq(discordIntegration.id, DISCORD_INTEGRATION_SINGLETON_ID))
          .for('update');
        if (!current) throw new Error('discord_integration singleton missing after upsert');

        const [row] = await tx
          .update(discordIntegration)
          .set({
            guildId: req.body.guild_id !== undefined ? req.body.guild_id : current.guildId,
            enabled: req.body.enabled ?? current.enabled,
            botTokenEncrypted: botToken === undefined ? current.botTokenEncrypted : encryptedToken,
            updatedAt: new Date(),
          })
          .where(eq(discordIntegration.id, DISCORD_INTEGRATION_SINGLETON_ID))
          .returning();
        if (!row) throw new Error('discord_integration singleton update returned no row');
        return { created: inserted.length > 0, existing: current, updated: row };
      });

      const after = integrationView(updated);
      req.auditSnapshots = {
        before: integrationView(created ? null : existing),
        after,
        targetId: DISCORD_INTEGRATION_SINGLETON_ID,
      };
      return after;
    },
  );
};

export default discordSettingsRoutes;
