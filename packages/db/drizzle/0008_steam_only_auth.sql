-- =====================================================================
-- 0008 — Steam-only login: drop email/password/TOTP identity surface,
-- pivot to players.steam_id64 (bigint) as the universal user anchor.
--
-- Destructive forward-only. Pre-launch panel — no prod data to preserve.
-- Rollback path: git revert + DROP DATABASE + CREATE DATABASE + db:migrate.
-- =====================================================================

BEGIN;

-- 1. Drop everything that depends on users.id (CASCADE catches indices,
--    triggers, FKs).
DROP TABLE IF EXISTS audit_log             CASCADE;
DROP TABLE IF EXISTS config_versions       CASCADE;
DROP TABLE IF EXISTS sessions              CASCADE;
DROP TABLE IF EXISTS user_api_tokens       CASCADE;
DROP TABLE IF EXISTS user_identities       CASCADE;
DROP TABLE IF EXISTS user_role_assignments CASCADE;
DROP TABLE IF EXISTS organization_members  CASCADE;
DROP TABLE IF EXISTS users                 CASCADE;

-- 2. Recreate identity-anchored tables on players.steam_id64.

CREATE TABLE sessions (
  id                text         PRIMARY KEY,
  steam_id64        bigint       NOT NULL REFERENCES players(steam_id64) ON DELETE CASCADE,
  expires_at        timestamptz  NOT NULL,
  last_activity_at  timestamptz  NOT NULL DEFAULT now(),
  ip                inet,
  user_agent        text,
  created_at        timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX sessions_steam_id64_idx     ON sessions(steam_id64);
CREATE INDEX sessions_expires_at_idx     ON sessions(expires_at);
CREATE INDEX sessions_last_activity_idx  ON sessions(last_activity_at);

CREATE TABLE player_role_assignments (
  steam_id64  bigint       NOT NULL REFERENCES players(steam_id64) ON DELETE CASCADE,
  role_id     uuid         NOT NULL REFERENCES roles(id)            ON DELETE CASCADE,
  assigned_by bigint                   REFERENCES players(steam_id64) ON DELETE SET NULL,
  assigned_at timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (steam_id64, role_id)
);
CREATE INDEX player_role_assignments_role_idx ON player_role_assignments(role_id);

CREATE TABLE organization_members (
  steam_id64       bigint       NOT NULL REFERENCES players(steam_id64) ON DELETE CASCADE,
  org_id           uuid         NOT NULL REFERENCES organizations(id)   ON DELETE CASCADE,
  primary_role_id  uuid                     REFERENCES roles(id),
  joined_at        timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (steam_id64, org_id)
);

CREATE TABLE player_api_tokens (
  id            uuid         PRIMARY KEY,
  steam_id64    bigint       NOT NULL REFERENCES players(steam_id64) ON DELETE CASCADE,
  name          text         NOT NULL,
  token_hash    text         NOT NULL,
  scopes        text[]       NOT NULL DEFAULT '{}',
  last_used_at  timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX player_api_tokens_steam_id64_idx ON player_api_tokens(steam_id64);

CREATE TABLE audit_log (
  id                 bigserial    PRIMARY KEY,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  actor_kind         text         NOT NULL,
  actor_steam_id64   bigint                REFERENCES players(steam_id64)        ON DELETE SET NULL,
  actor_token_id     uuid                  REFERENCES player_api_tokens(id)      ON DELETE SET NULL,
  actor_system_label text,
  actor_ip           inet,
  action_type        text         NOT NULL,
  target_type        text,
  target_id          text,
  before_snapshot    jsonb,
  after_snapshot     jsonb,
  context            jsonb        NOT NULL DEFAULT '{}'::jsonb,
  status_code        integer,
  duration_ms        integer,
  org_id             uuid                  REFERENCES organizations(id),
  prev_hash          bytea,
  row_hash           bytea        NOT NULL,
  CONSTRAINT audit_log_actor_kind CHECK (
    (actor_kind = 'steam'  AND actor_steam_id64 IS NOT NULL AND actor_system_label IS NULL) OR
    (actor_kind = 'system' AND actor_steam_id64 IS NULL     AND actor_system_label IS NOT NULL)
  )
);
CREATE INDEX audit_log_created_at_idx  ON audit_log(created_at DESC);
CREATE INDEX audit_log_actor_steam_idx ON audit_log(actor_steam_id64, created_at DESC)
  WHERE actor_steam_id64 IS NOT NULL;
CREATE INDEX audit_log_action_idx      ON audit_log(action_type, created_at DESC);
CREATE INDEX audit_log_target_idx      ON audit_log(target_type, target_id);

-- Hash-chain trigger — body identical to 0000_init.sql audit_log_append.
-- Hash payload omits actor fields by design; verifier in
-- scripts/verify-audit-chain.ts asserts the same canonical form.
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

-- 3. config_versions on steam_id64 author.

CREATE TABLE config_versions (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id           uuid         NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  filename            text         NOT NULL,
  content             text         NOT NULL,
  sha256              bytea        NOT NULL,
  parent_version_id   uuid,
  author_steam_id64   bigint                 REFERENCES players(steam_id64) ON DELETE SET NULL,
  author_label        text,
  author_ip           inet,
  message             text,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT config_versions_author_presence CHECK (
    author_steam_id64 IS NOT NULL OR author_label IS NOT NULL
  )
);
CREATE INDEX config_versions_server_file_time_idx
  ON config_versions(server_id, filename, created_at);
CREATE INDEX config_versions_sha256_idx ON config_versions(sha256);

-- Reject UPDATE/DELETE on config_versions (preserve append-only semantics).
CREATE OR REPLACE FUNCTION config_versions_deny()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'config_versions is append-only';
END;
$$;
CREATE TRIGGER trg_config_versions_no_upd
BEFORE UPDATE ON config_versions
FOR EACH ROW EXECUTE FUNCTION config_versions_deny();
CREATE TRIGGER trg_config_versions_no_del
BEFORE DELETE ON config_versions
FOR EACH ROW WHEN (pg_trigger_depth() = 0)
EXECUTE FUNCTION config_versions_deny();

COMMIT;
