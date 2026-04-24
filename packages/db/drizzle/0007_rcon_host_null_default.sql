-- Revert 0006: storing an absolute rcon_host value in credentials is
-- wrong because different services need different aliases for the same
-- Squad RCON listener. api is in the compose bridge network and must
-- go through host.docker.internal; worker-rcon runs with --network host
-- and reaches the listener at 127.0.0.1 directly. Allow rcon_host to
-- be NULL and set it so each caller falls back to its own
-- RCON_HOST_DEFAULT env var. Non-null values are reserved for operators
-- who explicitly want to pin a hostname (e.g. a remote Squad instance).

ALTER TABLE server_credentials ALTER COLUMN rcon_host DROP NOT NULL;

UPDATE server_credentials
SET rcon_host = NULL
WHERE rcon_host IN ('127.0.0.1', 'host.docker.internal');
