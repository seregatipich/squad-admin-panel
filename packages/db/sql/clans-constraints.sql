-- Constraint enforcement for the clans / clan_members model (CLAN-1).
--
-- Drizzle-kit generates the tables, columns, checks and indexes from
-- packages/db/src/schema/clans.ts, but the cross-row invariants below need
-- triggers. This file is idempotent (CREATE OR REPLACE + DROP TRIGGER IF
-- EXISTS) and is applied on top of the generated migration.

CREATE OR REPLACE FUNCTION clans_enforce_unique_tags() RETURNS trigger AS $$
DECLARE
  taken text;
BEGIN
  IF array_length(NEW.tags, 1) IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT other_tag INTO taken
  FROM clans AS other, unnest(other.tags) AS other_tag
  WHERE other.deleted_at IS NULL
    AND other.id <> NEW.id
    AND other_tag = ANY (NEW.tags)
  LIMIT 1;
  IF taken IS NOT NULL THEN
    RAISE EXCEPTION 'clan tag "%" already belongs to another clan', taken
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clans_unique_tags ON clans;
CREATE TRIGGER clans_unique_tags
  BEFORE INSERT OR UPDATE OF tags ON clans
  FOR EACH ROW EXECUTE FUNCTION clans_enforce_unique_tags();

CREATE OR REPLACE FUNCTION clans_enforce_priority_capacity() RETURNS trigger AS $$
DECLARE
  used integer;
BEGIN
  SELECT count(*) INTO used FROM clan_members
  WHERE clan_id = NEW.id AND has_priority;
  IF NEW.max_priority_slots < used THEN
    RAISE EXCEPTION
      'cannot lower max_priority_slots to % for clan %: % priority members are already assigned',
      NEW.max_priority_slots, NEW.id, used
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clans_priority_capacity ON clans;
CREATE TRIGGER clans_priority_capacity
  BEFORE UPDATE OF max_priority_slots ON clans
  FOR EACH ROW
  WHEN (NEW.max_priority_slots < OLD.max_priority_slots)
  EXECUTE FUNCTION clans_enforce_priority_capacity();

CREATE OR REPLACE FUNCTION clan_members_enforce_priority_limit() RETURNS trigger AS $$
DECLARE
  target_clan uuid;
  used integer;
  slots integer;
BEGIN
  target_clan := COALESCE(NEW.clan_id, OLD.clan_id);
  SELECT max_priority_slots INTO slots FROM clans WHERE id = target_clan;
  IF slots IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO used FROM clan_members
  WHERE clan_id = target_clan AND has_priority;
  IF used > slots THEN
    RAISE EXCEPTION
      'clan % priority slots exhausted: % assigned exceeds limit of %',
      target_clan, used, slots
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clan_members_priority_limit ON clan_members;
CREATE CONSTRAINT TRIGGER clan_members_priority_limit
  AFTER INSERT OR UPDATE OF has_priority, clan_id ON clan_members
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION clan_members_enforce_priority_limit();

CREATE OR REPLACE FUNCTION clan_members_enforce_single_leader() RETURNS trigger AS $$
DECLARE
  target_clan uuid;
  member_total integer;
  leader_total integer;
BEGIN
  target_clan := COALESCE(NEW.clan_id, OLD.clan_id);
  SELECT count(*), count(*) FILTER (WHERE member_role = 'leader')
    INTO member_total, leader_total
    FROM clan_members WHERE clan_id = target_clan;
  IF member_total = 0 THEN
    RETURN NULL;
  END IF;
  IF leader_total <> 1 THEN
    RAISE EXCEPTION
      'clan % must have exactly one leader, found %', target_clan, leader_total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clan_members_single_leader ON clan_members;
CREATE CONSTRAINT TRIGGER clan_members_single_leader
  AFTER INSERT OR DELETE OR UPDATE OF member_role, clan_id ON clan_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION clan_members_enforce_single_leader();
