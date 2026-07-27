-- DISCORD-5 (#152): discord_role_mappings — соответствие «роль панели → роль
-- Discord». Панель является источником истины: воркер
-- apps/workers/discord/src/role-sync.ts приводит Discord-роли каждого
-- слинкованного игрока (player_discord_links, 0098) к тому, что диктует его
-- players.role_id через эту таблицу.
--
-- role_id UNIQUE — одна роль панели соответствует не более чем одной роли
-- Discord (модель vip_sync/moderator_sync у SQSTAT). Индекс по discord_role_id
-- нужен обходу reconcile. См. packages/db/src/schema/discord-role-mappings.ts.

CREATE TABLE IF NOT EXISTS discord_role_mappings (
  id              uuid        PRIMARY KEY NOT NULL,
  role_id         uuid        NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  discord_role_id text        NOT NULL,
  enabled         boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS discord_role_mappings_role_id_key
  ON discord_role_mappings (role_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS discord_role_mappings_discord_role_id_idx
  ON discord_role_mappings (discord_role_id);
