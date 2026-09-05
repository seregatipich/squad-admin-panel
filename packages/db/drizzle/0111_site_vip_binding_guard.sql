-- Публичная VIP-привязка bss.games уже общего каталога панели: она выдаёт
-- только QueuePriority с правом `reserve` и не становится вторым магазином.
-- Все связанные записи используют общий lifecycle-fence, поэтому подготовка
-- привязки не может пересечься с изменением роли.
CREATE OR REPLACE FUNCTION enforce_site_vip_binding_safety()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected_role_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('vip-lifecycle-writer-fence', 0));

  IF TG_TABLE_NAME = 'vip_tiers' THEN
    IF NEW.is_active = true AND EXISTS (
      SELECT 1
        FROM vip_tiers tier
       WHERE tier.role_id = NEW.role_id
         AND tier.is_active = true
         AND tier.id <> NEW.id
         AND (tier.name = 'BSS VIP' OR NEW.name = 'BSS VIP')
    ) THEN
      RAISE EXCEPTION 'site_vip_binding_duplicate_role'
        USING ERRCODE = '23514', CONSTRAINT = 'site_vip_binding_duplicate_role_guard';
    END IF;

    IF NEW.is_active = true AND (
      NEW.name = 'BSS VIP' OR
      (TG_OP = 'UPDATE' AND OLD.name = 'BSS VIP' AND OLD.is_active = true)
    ) AND (
      NEW.name <> 'BSS VIP' OR
      NEW.default_days IS NOT NULL OR
      NEW.price_bonuses IS NOT NULL OR
      NOT EXISTS (
        SELECT 1
          FROM roles role
         WHERE role.id = NEW.role_id
           AND role.name = 'QueuePriority'
           AND role.panel_access = false
           AND role.is_system_role = false
      ) OR
      (SELECT count(*) FROM role_squad_permissions permission
        WHERE permission.role_id = NEW.role_id) <> 1 OR
      NOT EXISTS (
        SELECT 1
          FROM role_squad_permissions permission
         WHERE permission.role_id = NEW.role_id
           AND permission.squad_permission_key = 'reserve'
      )
    ) THEN
      RAISE EXCEPTION 'site_vip_binding_unsafe'
        USING ERRCODE = '23514', CONSTRAINT = 'site_vip_binding_safety_guard';
    END IF;
  ELSIF TG_TABLE_NAME = 'roles' THEN
    IF EXISTS (
      SELECT 1
        FROM vip_tiers tier
       WHERE tier.role_id = OLD.id
         AND tier.name = 'BSS VIP'
         AND tier.is_active = true
    ) AND (
      NEW.name <> 'QueuePriority' OR
      NEW.panel_access <> false OR
      NEW.is_system_role <> false
    ) THEN
      RAISE EXCEPTION 'site_vip_role_unsafe'
        USING ERRCODE = '23514', CONSTRAINT = 'site_vip_role_safety_guard';
    END IF;
  ELSIF TG_TABLE_NAME = 'role_squad_permissions' THEN
    IF TG_OP = 'INSERT' THEN
      affected_role_id := NEW.role_id;
    ELSE
      affected_role_id := OLD.role_id;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM vip_tiers tier
       WHERE tier.role_id = affected_role_id
         AND tier.name = 'BSS VIP'
         AND tier.is_active = true
    ) OR (
      TG_OP = 'UPDATE' AND NEW.role_id IS DISTINCT FROM OLD.role_id AND EXISTS (
        SELECT 1
          FROM vip_tiers tier
         WHERE tier.role_id = NEW.role_id
           AND tier.name = 'BSS VIP'
           AND tier.is_active = true
      )
    ) THEN
      RAISE EXCEPTION 'site_vip_role_permissions_locked'
        USING ERRCODE = '23514', CONSTRAINT = 'site_vip_role_permissions_guard';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_vip_tiers_site_binding_guard ON vip_tiers;
--> statement-breakpoint
CREATE TRIGGER trg_vip_tiers_site_binding_guard
BEFORE INSERT OR UPDATE OF name, role_id, default_days, price_bonuses, is_active ON vip_tiers
FOR EACH ROW EXECUTE FUNCTION enforce_site_vip_binding_safety();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_roles_site_vip_safety_guard ON roles;
--> statement-breakpoint
CREATE TRIGGER trg_roles_site_vip_safety_guard
BEFORE UPDATE OF name, panel_access, is_system_role ON roles
FOR EACH ROW EXECUTE FUNCTION enforce_site_vip_binding_safety();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_role_squad_permissions_site_vip_guard ON role_squad_permissions;
--> statement-breakpoint
CREATE TRIGGER trg_role_squad_permissions_site_vip_guard
BEFORE INSERT OR UPDATE OR DELETE ON role_squad_permissions
FOR EACH ROW EXECUTE FUNCTION enforce_site_vip_binding_safety();
