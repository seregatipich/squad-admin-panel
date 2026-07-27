-- DISCORD-4 (#151): player_discord_links — Discord-идентичность, привязанная к
-- игроку через OAuth2 (scope `identify`). Строгое 1:1 в обе стороны:
-- player_id PRIMARY KEY → один игрок = одна привязка; discord_user_id UNIQUE →
-- один Discord-аккаунт = один игрок. Конфликт ловится нарушением UNIQUE (23505)
-- и превращается роутом в 409. discord_username — снимок на момент привязки,
-- авто-рефреш потребует бота (DISCORD-6). См.
-- packages/db/src/schema/player-discord-links.ts.

CREATE TABLE IF NOT EXISTS player_discord_links (
  player_id        uuid        PRIMARY KEY NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  discord_user_id  text        NOT NULL,
  discord_username text        NOT NULL,
  linked_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_discord_links_discord_user_id_unique UNIQUE (discord_user_id)
);
