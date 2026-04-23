-- =====================================================================
-- Phase 0 initial schema (single forward-only migration)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------
-- identity + auth
-- ---------------------------------------------------------------------

CREATE TABLE users (
  id                     uuid        PRIMARY KEY,
  email                  text        NOT NULL,
  password_hash          text        NOT NULL,
  display_name           text,
  totp_secret_encrypted  bytea,
  totp_key_version       integer     NOT NULL DEFAULT 1,
  totp_backup_codes_hash text[],
  totp_last_used_step    integer,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
CREATE INDEX users_created_at_idx ON users (created_at);

CREATE TABLE sessions (
  id         text        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  ip         inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx    ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE user_identities (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text        NOT NULL CHECK (kind IN ('steam','discord','eos')),
  external_id  text        NOT NULL,
  verified     boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, external_id)
);

CREATE TABLE user_api_tokens (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  token_hash   text        NOT NULL,
  scopes       text[]      NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

-- ---------------------------------------------------------------------
-- org + rbac
-- ---------------------------------------------------------------------

CREATE TABLE organizations (
  id         uuid        PRIMARY KEY,
  name       text        NOT NULL,
  slug       text        NOT NULL UNIQUE,
  settings   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id               uuid        PRIMARY KEY,
  org_id           uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text        NOT NULL,
  description      text,
  clearance_level  integer     NOT NULL DEFAULT 0,
  is_system_role   boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name),
  CONSTRAINT roles_clearance_range CHECK (clearance_level BETWEEN 0 AND 1000)
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE servers (
  id           uuid        PRIMARY KEY,
  org_id       uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  display_name text        NOT NULL,
  slug         text        NOT NULL,
  description  text,
  status       text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','installing','ready','starting','running','stopping','stopped','failed')),
  tags         text[]      NOT NULL DEFAULT '{}',
  timezone     text        NOT NULL DEFAULT 'UTC',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);
CREATE INDEX servers_org_status_idx ON servers(org_id, status);

CREATE TABLE role_server_scopes (
  role_id   uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  server_id uuid REFERENCES servers(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, server_id)
);

CREATE TABLE organization_members (
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id          uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  primary_role_id uuid        REFERENCES roles(id),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);

CREATE TABLE user_role_assignments (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- ---------------------------------------------------------------------
-- server credentials + settings
-- ---------------------------------------------------------------------

CREATE TABLE server_credentials (
  server_id              uuid    PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  rcon_host              text    NOT NULL DEFAULT '127.0.0.1',
  rcon_port              integer NOT NULL,
  rcon_password_encrypted bytea  NOT NULL,
  license_key_encrypted  bytea,
  key_version            integer NOT NULL DEFAULT 1
);

CREATE TABLE server_settings (
  server_id            uuid    PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  install_path         text    NOT NULL,
  game_port            integer NOT NULL,
  query_port           integer NOT NULL,
  beacon_port          integer NOT NULL,
  rcon_port            integer NOT NULL,
  max_players          integer NOT NULL DEFAULT 100,
  tickrate             integer NOT NULL DEFAULT 50,
  multihome            inet,
  extra_args           text    NOT NULL DEFAULT '',
  launch_args_override text,
  cpu_affinity         text,
  cpu_weight           integer,
  niceness             integer,
  memory_high_mb       integer,
  memory_max_mb        integer,
  io_weight            integer
);

-- ---------------------------------------------------------------------
-- players + history
-- ---------------------------------------------------------------------

CREATE TABLE players (
  steam_id64                bigint      PRIMARY KEY,
  canonical_name            text        NOT NULL,
  canonical_name_normalized text        NOT NULL,
  eos_id                    text,
  battle_eye_guid           text,
  last_known_ip             inet,
  first_seen_at             timestamptz NOT NULL DEFAULT now(),
  last_seen_at              timestamptz NOT NULL DEFAULT now(),
  total_time_played_seconds bigint      NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX players_eos_id_unique_idx
  ON players(eos_id) WHERE eos_id IS NOT NULL;
CREATE INDEX players_canonical_name_normalized_idx
  ON players(canonical_name_normalized);
CREATE INDEX players_last_seen_at_idx
  ON players(last_seen_at DESC);

CREATE TABLE player_name_history (
  id                bigserial    PRIMARY KEY,
  steam_id64        bigint       NOT NULL REFERENCES players(steam_id64) ON DELETE CASCADE,
  name              text         NOT NULL,
  name_normalized   text         NOT NULL,
  first_seen_at     timestamptz  NOT NULL DEFAULT now(),
  last_seen_at      timestamptz  NOT NULL DEFAULT now(),
  observation_count integer      NOT NULL DEFAULT 1,
  UNIQUE (steam_id64, name_normalized)
);
CREATE INDEX player_name_history_name_normalized_idx
  ON player_name_history(name_normalized);
CREATE INDEX player_name_history_last_seen_at_idx
  ON player_name_history(last_seen_at DESC);

CREATE TABLE player_ip_history (
  id                bigserial    PRIMARY KEY,
  steam_id64        bigint       NOT NULL REFERENCES players(steam_id64) ON DELETE CASCADE,
  ip                inet         NOT NULL,
  first_seen_at     timestamptz  NOT NULL DEFAULT now(),
  last_seen_at      timestamptz  NOT NULL DEFAULT now(),
  observation_count integer      NOT NULL DEFAULT 1,
  UNIQUE (steam_id64, ip)
);
CREATE INDEX player_ip_history_ip_idx ON player_ip_history(ip);

-- ---------------------------------------------------------------------
-- events + idempotency
-- ---------------------------------------------------------------------

CREATE TABLE events (
  event_id       uuid        NOT NULL,
  server_id      uuid        REFERENCES servers(id) ON DELETE CASCADE,
  occurred_at    timestamptz NOT NULL,
  kind           text        NOT NULL,
  version        integer     NOT NULL DEFAULT 1,
  actor_kind     text,
  actor_id       text,
  correlation_id uuid,
  payload        jsonb       NOT NULL,
  PRIMARY KEY (event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Bootstrap partitions: current month + 3 look-ahead months.
-- pg_partman / pg_cron take over in a later migration when they are
-- available; for P0 with single-host deploys, the bootstrap partitions
-- are sufficient and the backup/retention job drops old ones monthly.
DO $$
DECLARE
  m          int;
  cur_month  date := date_trunc('month', now())::date;
  part_start date;
  part_end   date;
  part_name  text;
BEGIN
  FOR m IN 0..5 LOOP
    part_start := cur_month + (m || ' months')::interval;
    part_end   := part_start + interval '1 month';
    part_name  := 'events_' || to_char(part_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
      part_name, part_start, part_end
    );
  END LOOP;
END$$;

CREATE INDEX events_server_occurred_idx ON events(server_id, occurred_at DESC);
CREATE INDEX events_kind_occurred_idx
  ON events(kind, occurred_at DESC)
  WHERE kind IN ('player.connected','player.disconnected','rcon.players_polled');

CREATE TABLE processed_events (
  event_id     uuid        PRIMARY KEY,
  group_name   text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processed_events_group_idx ON processed_events(group_name, processed_at);

-- ---------------------------------------------------------------------
-- audit log (append-only, hash-chained)
-- ---------------------------------------------------------------------

CREATE TABLE audit_log (
  id              bigserial   PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid        REFERENCES users(id),
  actor_ip        inet,
  actor_kind      text        NOT NULL DEFAULT 'user',
  action_type     text        NOT NULL,
  target_type     text,
  target_id       text,
  before_snapshot jsonb,
  after_snapshot  jsonb,
  context         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status_code     integer,
  duration_ms     integer,
  org_id          uuid        REFERENCES organizations(id),
  prev_hash       bytea,
  row_hash        bytea       NOT NULL
);
CREATE INDEX audit_log_created_at_idx ON audit_log(created_at DESC);
CREATE INDEX audit_log_actor_idx       ON audit_log(actor_user_id, created_at DESC);
CREATE INDEX audit_log_action_idx      ON audit_log(action_type, created_at DESC);
CREATE INDEX audit_log_target_idx      ON audit_log(target_type, target_id);

-- Trigger: compute hash-chain entries; deny UPDATE / DELETE.

CREATE OR REPLACE FUNCTION audit_log_append()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_log', 0));
  SELECT row_hash INTO prev FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.row_hash := digest(
    COALESCE(prev, ''::bytea) ||
    convert_to(
      NEW.action_type
        || '|' || COALESCE(NEW.target_type, '')
        || '|' || COALESCE(NEW.target_id, '')
        || '|' || NEW.context::text
        || '|' || NEW.created_at::text,
      'UTF8'
    ),
    'sha256'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_log_ins
BEFORE INSERT ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_append();

CREATE OR REPLACE FUNCTION audit_log_deny()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

CREATE TRIGGER trg_audit_log_no_upd
BEFORE UPDATE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_deny();

CREATE TRIGGER trg_audit_log_no_del
BEFORE DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_deny();
