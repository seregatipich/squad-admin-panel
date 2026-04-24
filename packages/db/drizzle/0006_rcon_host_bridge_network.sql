-- Existing server_credentials rows carry rcon_host='127.0.0.1', which was
-- correct when a previous iteration of the API ran with --network host but
-- stops resolving once the api container sits in the compose bridge network
-- alongside postgres/redis. Squad itself still binds on the host's
-- 127.0.0.1:{port} (it's launched with --network host), so api needs to
-- reach it through the host-gateway alias. docker-compose.yml now maps
-- host.docker.internal to host-gateway for the api container; migrate the
-- stored value so the reload path (PUT /configs) and graceful stop can
-- connect without code branches.

UPDATE server_credentials
SET rcon_host = 'host.docker.internal'
WHERE rcon_host = '127.0.0.1';
