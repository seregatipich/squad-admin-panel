-- Widens the server runtime enum so a row can describe a Squad instance the
-- panel does not host. `external` servers carry a non-NULL
-- server_credentials.rcon_host and are reached only over RCON/A2S; every
-- container-bound component (status reconciler, log ingest, config sync,
-- install/start/stop) filters on runtime = 'container'. Additive: existing
-- rows keep runtime = 'container' and the old value stays valid.

ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_runtime_enum;
--> statement-breakpoint
ALTER TABLE servers
  ADD CONSTRAINT servers_runtime_enum CHECK (runtime IN ('container', 'external'));
