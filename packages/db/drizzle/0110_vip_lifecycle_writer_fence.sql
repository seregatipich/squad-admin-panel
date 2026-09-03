ALTER TABLE "panel_meta" ADD COLUMN "vip_lifecycle_strict" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- Every role projection writer, VIP catalog mutation, lifecycle event mutation,
-- and fence toggle takes the same transaction lock.  The cutover audit takes
-- this lock too, so no assignment can slip between its snapshot and enabling
-- the durable fence.
CREATE OR REPLACE FUNCTION lock_vip_lifecycle_writer_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  strict_enabled boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('vip-lifecycle-writer-fence', 0));

  SELECT vip_lifecycle_strict
    INTO strict_enabled
    FROM panel_meta
   WHERE id = 1;

  -- The durable cutover must also fence an already-running relaxed API (or an
  -- old binary): after the flag is set, a newly accepted lifecycle event must
  -- carry a revision and the exact, unique, safe active tier mapping.
  IF TG_TABLE_NAME = 'vip_lifecycle_events' AND TG_OP = 'INSERT' THEN
    IF strict_enabled IS TRUE AND (
      NEW.revision IS NULL OR
      NEW.player_id IS NULL OR
      NEW.role_id IS NULL OR
      NEW.tier IS NULL OR
      NOT EXISTS (
        SELECT 1
          FROM vip_tiers tier
          JOIN roles role ON role.id = tier.role_id
         WHERE tier.id::text = NEW.tier
           AND tier.role_id = NEW.role_id
           AND tier.is_active = true
           AND role.is_system_role = false
           AND role.panel_access = false
      ) OR
      EXISTS (
        SELECT 1
          FROM vip_tiers other_tier
         WHERE other_tier.role_id = NEW.role_id
           AND other_tier.is_active = true
           AND other_tier.id::text <> NEW.tier
      )
    ) THEN
      RAISE EXCEPTION 'vip_lifecycle_revision_required'
        USING ERRCODE = '23514', CONSTRAINT = 'vip_lifecycle_event_strict_guard';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'vip_lifecycle_events' AND strict_enabled IS TRUE THEN
    IF TG_OP = 'DELETE' AND EXISTS (
      SELECT 1
        FROM players player
       WHERE player.role_lifecycle_event_id = OLD.event_id
    ) THEN
      RAISE EXCEPTION 'vip_lifecycle_required'
        USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
    END IF;

    -- Lifecycle rows are immutable after cutover. The sole permitted UPDATE is
    -- the one-way supersession link to a freshly inserted, applied, higher
    -- revision event. Applying this rule to every row (not only the row that a
    -- player currently references) prevents a no-op UPDATE from laundering a
    -- precommitted tuple into pg_current_xact_id() via xmin.
    IF TG_OP = 'UPDATE' THEN
      IF OLD.event_id IS DISTINCT FROM NEW.event_id OR
         OLD.event_type IS DISTINCT FROM NEW.event_type OR
         OLD.player_id IS DISTINCT FROM NEW.player_id OR
         OLD.role_id IS DISTINCT FROM NEW.role_id OR
         OLD.tier IS DISTINCT FROM NEW.tier OR
         OLD.purchase_id IS DISTINCT FROM NEW.purchase_id OR
         OLD.revision IS DISTINCT FROM NEW.revision OR
         OLD.request_hash IS DISTINCT FROM NEW.request_hash OR
         OLD.action IS DISTINCT FROM NEW.action OR
         OLD.payload IS DISTINCT FROM NEW.payload OR
         OLD.received_at IS DISTINCT FROM NEW.received_at OR
         OLD.applied_at IS DISTINCT FROM NEW.applied_at OR
         OLD.superseded_by_event_id IS NOT NULL OR
         NEW.superseded_by_event_id IS NULL OR
         NOT EXISTS (
           SELECT 1
             FROM vip_lifecycle_events superseding
            WHERE superseding.event_id = NEW.superseded_by_event_id
              AND superseding.xmin = pg_current_xact_id()::text::xid
              AND superseding.player_id = OLD.player_id
              AND superseding.revision IS NOT NULL
              AND superseding.applied_at IS NOT NULL
              AND (OLD.revision IS NULL OR superseding.revision > OLD.revision)
         ) THEN
        RAISE EXCEPTION 'vip_lifecycle_required'
          USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'vip_tiers' AND strict_enabled IS TRUE THEN
    IF TG_OP = 'INSERT' AND NEW.is_active = true AND EXISTS (
      SELECT 1
        FROM players player
        JOIN vip_lifecycle_events event
          ON event.event_id = player.role_lifecycle_event_id
         AND event.player_id = player.id
         AND event.role_id = player.role_id
         AND event.action = 'assigned'
         AND event.applied_at IS NOT NULL
         AND event.superseded_by_event_id IS NULL
       WHERE player.role_id = NEW.role_id
    ) THEN
      RAISE EXCEPTION 'vip_lifecycle_catalog_in_use'
        USING ERRCODE = '23514', CONSTRAINT = 'vip_lifecycle_catalog_guard';
    END IF;

    IF TG_OP = 'DELETE' AND EXISTS (
      SELECT 1
        FROM players player
        JOIN vip_lifecycle_events event
          ON event.event_id = player.role_lifecycle_event_id
         AND event.player_id = player.id
         AND event.role_id = player.role_id
         AND event.action = 'assigned'
         AND event.applied_at IS NOT NULL
         AND event.superseded_by_event_id IS NULL
       WHERE player.role_id = OLD.role_id
    ) THEN
      RAISE EXCEPTION 'vip_lifecycle_catalog_in_use'
        USING ERRCODE = '23514', CONSTRAINT = 'vip_lifecycle_catalog_guard';
    END IF;

    IF TG_OP = 'UPDATE' AND
       (OLD.id IS DISTINCT FROM NEW.id OR
        OLD.role_id IS DISTINCT FROM NEW.role_id OR
        OLD.is_active IS DISTINCT FROM NEW.is_active) AND EXISTS (
         SELECT 1
           FROM players player
           JOIN vip_lifecycle_events event
             ON event.event_id = player.role_lifecycle_event_id
            AND event.player_id = player.id
            AND event.role_id = player.role_id
            AND event.action = 'assigned'
            AND event.applied_at IS NOT NULL
            AND event.superseded_by_event_id IS NULL
          WHERE player.role_id = OLD.role_id
       ) THEN
      RAISE EXCEPTION 'vip_lifecycle_catalog_in_use'
        USING ERRCODE = '23514', CONSTRAINT = 'vip_lifecycle_catalog_guard';
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.is_active = true AND
       (OLD.role_id IS DISTINCT FROM NEW.role_id OR OLD.is_active IS DISTINCT FROM NEW.is_active) AND
       EXISTS (
         SELECT 1
           FROM players player
           JOIN vip_lifecycle_events event
             ON event.event_id = player.role_lifecycle_event_id
            AND event.player_id = player.id
            AND event.role_id = player.role_id
            AND event.action = 'assigned'
            AND event.applied_at IS NOT NULL
            AND event.superseded_by_event_id IS NULL
          WHERE player.role_id = NEW.role_id
       ) THEN
      RAISE EXCEPTION 'vip_lifecycle_catalog_in_use'
        USING ERRCODE = '23514', CONSTRAINT = 'vip_lifecycle_catalog_guard';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'roles' THEN
    IF TG_OP = 'UPDATE' AND strict_enabled IS TRUE AND
       (NEW.panel_access = true OR NEW.is_system_role = true) AND
       (OLD.panel_access IS DISTINCT FROM NEW.panel_access OR
        OLD.is_system_role IS DISTINCT FROM NEW.is_system_role) AND
       EXISTS (
         SELECT 1
           FROM players player
           JOIN vip_lifecycle_events event
             ON event.event_id = player.role_lifecycle_event_id
            AND event.player_id = player.id
            AND event.role_id = player.role_id
            AND event.action = 'assigned'
            AND event.applied_at IS NOT NULL
            AND event.superseded_by_event_id IS NULL
          WHERE player.role_id = OLD.id
       ) THEN
      RAISE EXCEPTION 'vip_lifecycle_catalog_in_use'
        USING ERRCODE = '23514', CONSTRAINT = 'vip_lifecycle_catalog_guard';
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'panel_meta' THEN
    IF TG_OP = 'DELETE' AND OLD.vip_lifecycle_strict = true THEN
      RAISE EXCEPTION 'vip_lifecycle_fence_rollback_required'
        USING ERRCODE = '23514', CONSTRAINT = 'vip_lifecycle_fence_rollback_guard';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.vip_lifecycle_strict = true AND
       NEW.vip_lifecycle_strict = false AND
       current_setting('squad.vip_lifecycle_fence_rollback', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'vip_lifecycle_fence_rollback_required'
        USING ERRCODE = '23514', CONSTRAINT = 'vip_lifecycle_fence_rollback_guard';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_players_vip_lifecycle_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  lifecycle_event vip_lifecycle_events%ROWTYPE;
  previous_event vip_lifecycle_events%ROWTYPE;
  lifecycle_expiry timestamptz;
  expected_comment text;
  strict_enabled boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('vip-lifecycle-writer-fence', 0));

  SELECT vip_lifecycle_strict
    INTO strict_enabled
    FROM panel_meta
   WHERE id = 1;
  IF strict_enabled IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;

  -- Once an external owner exists, only a newer exact lifecycle revocation
  -- may clear it.  Replacing it with an ordinary role is never a revoke.
  IF TG_OP = 'UPDATE' AND OLD.role_lifecycle_event_id IS NOT NULL AND
     NEW.role_lifecycle_event_id IS NULL THEN
    IF NEW.role_id IS NOT NULL OR NEW.role_expires_at IS NOT NULL OR NEW.role_comment IS NOT NULL THEN
      RAISE EXCEPTION 'vip_lifecycle_required'
        USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
    END IF;

    SELECT event.*
      INTO previous_event
      FROM vip_lifecycle_events event
     WHERE event.event_id = OLD.role_lifecycle_event_id
       AND event.player_id = OLD.id
       AND event.role_id = OLD.role_id
       AND event.action = 'assigned'
       AND event.applied_at IS NOT NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'vip_lifecycle_required'
        USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
    END IF;

    BEGIN
      lifecycle_expiry := (previous_event.payload->>'expires_at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'vip_lifecycle_required'
        USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
    END;
    expected_comment := 'VIP ' || COALESCE(previous_event.tier, 'vip') ||
      CASE
        WHEN previous_event.purchase_id IS NULL THEN ''
        ELSE ' purchase ' || previous_event.purchase_id
      END;
    IF lifecycle_expiry IS DISTINCT FROM OLD.role_expires_at OR
       expected_comment IS DISTINCT FROM OLD.role_comment THEN
      RAISE EXCEPTION 'vip_lifecycle_required'
        USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
    END IF;

    SELECT event.*
      INTO lifecycle_event
      FROM vip_lifecycle_events event
     WHERE event.player_id = OLD.id
       AND event.role_id = OLD.role_id
       AND event.action = 'revoked'
       AND event.xmin = pg_current_xact_id()::text::xid
       AND event.revision IS NOT NULL
       AND event.applied_at IS NOT NULL
       AND event.superseded_by_event_id IS NULL
       AND event.purchase_id IS NOT DISTINCT FROM previous_event.purchase_id
       AND (previous_event.revision IS NULL OR event.revision > previous_event.revision)
       AND EXISTS (
         SELECT 1
           FROM vip_tiers tier
           JOIN roles role ON role.id = tier.role_id
          WHERE tier.id::text = event.tier
            AND tier.role_id = OLD.role_id
            AND tier.is_active = true
            AND role.is_system_role = false
            AND role.panel_access = false
       )
       AND NOT EXISTS (
         SELECT 1
           FROM vip_tiers other_tier
          WHERE other_tier.role_id = OLD.role_id
            AND other_tier.is_active = true
            AND other_tier.id::text <> event.tier
       )
       AND NOT EXISTS (
         SELECT 1
           FROM vip_lifecycle_events newer_event
          WHERE newer_event.player_id = OLD.id
            AND newer_event.revision IS NOT NULL
            AND newer_event.applied_at IS NOT NULL
            AND newer_event.superseded_by_event_id IS NULL
            AND newer_event.revision > event.revision
       )
     ORDER BY event.revision DESC
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'vip_lifecycle_required'
        USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
    END IF;
    IF previous_event.superseded_by_event_id IS DISTINCT FROM lifecycle_event.event_id THEN
      RAISE EXCEPTION 'vip_lifecycle_required'
        USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role_id IS NULL THEN
    IF NEW.role_lifecycle_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'vip_lifecycle_required'
        USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM vip_tiers WHERE role_id = NEW.role_id) THEN
    IF NEW.role_lifecycle_event_id IS NOT NULL OR
       (TG_OP = 'UPDATE' AND OLD.role_lifecycle_event_id IS NOT NULL) THEN
      RAISE EXCEPTION 'vip_lifecycle_required'
        USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role_lifecycle_event_id IS NULL THEN
    RAISE EXCEPTION 'vip_lifecycle_required'
      USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
  END IF;

  SELECT event.*
    INTO lifecycle_event
    FROM vip_lifecycle_events event
   WHERE event.event_id = NEW.role_lifecycle_event_id
     AND event.xmin = pg_current_xact_id()::text::xid
     AND event.player_id = NEW.id
     AND event.role_id = NEW.role_id
     AND event.action = 'assigned'
     AND event.revision IS NOT NULL
     AND event.applied_at IS NOT NULL
     AND event.superseded_by_event_id IS NULL
     AND EXISTS (
       SELECT 1
         FROM vip_tiers tier
         JOIN roles role ON role.id = tier.role_id
        WHERE tier.id::text = event.tier
          AND tier.role_id = NEW.role_id
          AND tier.is_active = true
          AND role.is_system_role = false
          AND role.panel_access = false
     )
     AND NOT EXISTS (
       SELECT 1
         FROM vip_tiers other_tier
        WHERE other_tier.role_id = NEW.role_id
          AND other_tier.is_active = true
          AND other_tier.id::text <> event.tier
     )
     AND NOT EXISTS (
       SELECT 1
         FROM vip_lifecycle_events newer_event
        WHERE newer_event.player_id = NEW.id
          AND newer_event.revision IS NOT NULL
          AND newer_event.applied_at IS NOT NULL
          AND newer_event.superseded_by_event_id IS NULL
          AND newer_event.revision > event.revision
     );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vip_lifecycle_required'
      USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.role_lifecycle_event_id IS NOT NULL THEN
    SELECT event.*
      INTO previous_event
      FROM vip_lifecycle_events event
     WHERE event.event_id = OLD.role_lifecycle_event_id
       AND event.player_id = OLD.id
       AND event.role_id = OLD.role_id
       AND event.action = 'assigned'
       AND event.applied_at IS NOT NULL;
    IF NOT FOUND OR
       previous_event.superseded_by_event_id IS DISTINCT FROM lifecycle_event.event_id OR
       (previous_event.revision IS NOT NULL AND
        lifecycle_event.revision <= previous_event.revision) THEN
      RAISE EXCEPTION 'vip_lifecycle_required'
        USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
    END IF;
  END IF;

  BEGIN
    lifecycle_expiry := (lifecycle_event.payload->>'expires_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'vip_lifecycle_required'
      USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
  END;
  expected_comment := 'VIP ' || COALESCE(lifecycle_event.tier, 'vip') ||
    CASE
      WHEN lifecycle_event.purchase_id IS NULL THEN ''
      ELSE ' purchase ' || lifecycle_event.purchase_id
    END;

  IF lifecycle_expiry IS DISTINCT FROM NEW.role_expires_at OR
     expected_comment IS DISTINCT FROM NEW.role_comment THEN
    RAISE EXCEPTION 'vip_lifecycle_required'
      USING ERRCODE = '23514', CONSTRAINT = 'players_vip_lifecycle_owner_guard';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_players_vip_lifecycle_owner_guard ON players;
--> statement-breakpoint
CREATE TRIGGER trg_players_vip_lifecycle_owner_guard
BEFORE INSERT OR UPDATE OF role_id, role_expires_at, role_comment, role_lifecycle_event_id ON players
FOR EACH ROW EXECUTE FUNCTION enforce_players_vip_lifecycle_owner();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_vip_tiers_writer_fence_lock ON vip_tiers;
--> statement-breakpoint
CREATE TRIGGER trg_vip_tiers_writer_fence_lock
BEFORE INSERT OR UPDATE OR DELETE ON vip_tiers
FOR EACH ROW EXECUTE FUNCTION lock_vip_lifecycle_writer_fence();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_roles_vip_lifecycle_safety_guard ON roles;
--> statement-breakpoint
CREATE TRIGGER trg_roles_vip_lifecycle_safety_guard
BEFORE UPDATE OF panel_access, is_system_role ON roles
FOR EACH ROW EXECUTE FUNCTION lock_vip_lifecycle_writer_fence();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_vip_lifecycle_events_writer_fence_lock ON vip_lifecycle_events;
--> statement-breakpoint
CREATE TRIGGER trg_vip_lifecycle_events_writer_fence_lock
BEFORE INSERT OR UPDATE OR DELETE ON vip_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION lock_vip_lifecycle_writer_fence();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_panel_meta_vip_lifecycle_fence_lock ON panel_meta;
--> statement-breakpoint
CREATE TRIGGER trg_panel_meta_vip_lifecycle_fence_lock
BEFORE UPDATE OF vip_lifecycle_strict ON panel_meta
FOR EACH ROW EXECUTE FUNCTION lock_vip_lifecycle_writer_fence();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_panel_meta_vip_lifecycle_fence_delete ON panel_meta;
--> statement-breakpoint
CREATE TRIGGER trg_panel_meta_vip_lifecycle_fence_delete
BEFORE DELETE ON panel_meta
FOR EACH ROW EXECUTE FUNCTION lock_vip_lifecycle_writer_fence();
