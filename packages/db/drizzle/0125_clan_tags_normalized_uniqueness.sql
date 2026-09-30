-- See packages/db/sql/clans-constraints.sql (#1088).
--
-- Rollback-safe: `clans_enforce_unique_tags` and the advisory-lock key it
-- takes are both internal to this trigger; the previous release neither
-- calls `clans_normalize_tag` nor depends on the old exact-match comparison.
CREATE OR REPLACE FUNCTION clans_normalize_tag(tag text) RETURNS text AS $$
  SELECT lower(trim(both '[](){}<>' from trim(tag)));
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION clans_enforce_unique_tags() RETURNS trigger AS $$
DECLARE
  taken text;
BEGIN
  IF array_length(NEW.tags, 1) IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('clans-tags'));
  SELECT other_tag INTO taken
  FROM clans AS other, unnest(other.tags) AS other_tag
  WHERE other.deleted_at IS NULL
    AND other.id <> NEW.id
    AND clans_normalize_tag(other_tag) IN (
      SELECT clans_normalize_tag(t) FROM unnest(NEW.tags) AS t
    )
  LIMIT 1;
  IF taken IS NOT NULL THEN
    RAISE EXCEPTION 'clan tag "%" already belongs to another clan', taken
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
