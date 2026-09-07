-- Remote log source for external servers (servers.runtime = 'external'):
-- worker-log-ingest opens an SSH session to the game host with the stored
-- key and tails `log_path` into the same SquadGame.log parser the container
-- tail feeds. One row per server; the private key is AES-GCM encrypted with
-- APP_ENCRYPTION_KEY (same blob format as server_credentials), the public
-- key is the authorized_keys line shown to the operator, and the host key
-- fingerprint is trust-on-first-use (NULL until the first connect).

CREATE TABLE IF NOT EXISTS server_log_sources (
  server_id uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'ssh',
  ssh_host text NOT NULL,
  ssh_port integer NOT NULL DEFAULT 22,
  ssh_user text NOT NULL,
  ssh_private_key_encrypted bytea NOT NULL,
  ssh_public_key text NOT NULL,
  host_key_fingerprint text,
  log_path text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  key_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT server_log_sources_kind_chk CHECK (kind IN ('ssh'))
);
