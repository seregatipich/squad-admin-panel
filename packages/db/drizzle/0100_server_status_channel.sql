-- DISCORD-6 (#153): servers.status_channel_id — идентификатор Discord-канала,
-- имя которого воркер apps/workers/discord переименовывает в живой статус
-- сервера по шаблону {emoji}{map}_{players}x{queue}_{admins} (модель chan_id у
-- SQSTAT, 16-settings.md §16.3).
--
-- Колонка на servers, а не отдельная таблица: один статус-канал на сервер —
-- та же кардинальность, что у конкурента. NULL = статус-канал для сервера не
-- настроен, воркер такой сервер пропускает. Снежинка Discord хранится как text,
-- потому что она 64-битная и беззнаковая (bigint её не вмещает целиком) — так же
-- хранятся discord_role_mappings.discord_role_id и
-- player_discord_links.discord_user_id. См. packages/db/src/schema/servers.ts.

ALTER TABLE servers ADD COLUMN IF NOT EXISTS status_channel_id text;
