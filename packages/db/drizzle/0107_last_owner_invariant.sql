-- Keep the panel recoverable: once at least one player has the system Owner role,
-- no role assignment writer may remove the final one. The advisory transaction
-- lock serializes concurrent API, worker, and direct-SQL updates before the
-- remaining-owner check is evaluated.

CREATE OR REPLACE FUNCTION enforce_players_last_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_role_id uuid;
BEGIN
  SELECT id
    INTO owner_role_id
    FROM roles
   WHERE name = 'Owner' AND is_system_role = true
   LIMIT 1;

  IF owner_role_id IS NULL OR OLD.role_id IS DISTINCT FROM owner_role_id THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.role_id IS NOT DISTINCT FROM OLD.role_id THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('players:last-owner', 0));
  IF NOT EXISTS (
    SELECT 1
      FROM players
     WHERE role_id = owner_role_id
       AND id <> OLD.id
  ) THEN
    RAISE EXCEPTION 'cannot_remove_last_owner'
      USING ERRCODE = '23514', CONSTRAINT = 'players_last_owner_guard';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_players_last_owner_guard ON players;
--> statement-breakpoint
CREATE TRIGGER trg_players_last_owner_guard
BEFORE UPDATE OF role_id OR DELETE ON players
FOR EACH ROW EXECUTE FUNCTION enforce_players_last_owner();
--> statement-breakpoint

-- A role delete uses the role_id foreign key's ON DELETE SET NULL action. Guard
-- the system Owner identity itself so that cascade cannot bypass the player
-- trigger while the referenced role row is disappearing.
CREATE OR REPLACE FUNCTION enforce_owner_role_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.name = 'Owner' AND OLD.is_system_role = true THEN
    IF TG_OP = 'DELETE' OR NEW.name IS DISTINCT FROM OLD.name OR NEW.is_system_role = false THEN
      RAISE EXCEPTION 'cannot_modify_owner_role_identity'
        USING ERRCODE = '23514', CONSTRAINT = 'roles_owner_identity_guard';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_roles_owner_identity_guard ON roles;
--> statement-breakpoint
CREATE TRIGGER trg_roles_owner_identity_guard
BEFORE UPDATE OF name, is_system_role OR DELETE ON roles
FOR EACH ROW EXECUTE FUNCTION enforce_owner_role_identity();
