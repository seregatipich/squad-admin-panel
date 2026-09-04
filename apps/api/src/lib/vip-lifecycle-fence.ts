import { createHash } from 'node:crypto';
import type { DatabaseClient } from '@squad/db';
import { findCurrentVipLifecycleAssignment, findVipLifecycleOwner } from '@squad/db';
import {
  panelMeta,
  players,
  roleSquadPermissions,
  roles,
  vipLifecycleEvents,
  vipTiers,
} from '@squad/db/schema';
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

export interface VipOwnershipAuditResult {
  activeAssignments: number;
  orphanedAssignments: number;
  conflictingAssignments: number;
}

export class VipLifecycleOwnershipAuditError extends Error {
  constructor(readonly result: VipOwnershipAuditResult) {
    super('VIP lifecycle ownership audit failed');
  }
}

export class VipLifecycleFenceModeError extends Error {
  constructor() {
    super('VIP lifecycle fence mode mismatch');
  }
}

export class VipLifecycleFenceIntegrityError extends Error {
  constructor() {
    super('VIP lifecycle fence integrity check failed');
  }
}

type FenceTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

interface FenceFunctionRow extends Record<string, unknown> {
  name: string;
  ownerMatches: boolean;
  language: string;
  securityDefiner: boolean;
  volatility: string;
  config: string[] | null;
  kind: string;
  returnsTrigger: boolean;
  argumentCount: number;
  parallel: string;
  leakproof: boolean;
  strict: boolean;
  source: string;
}

interface FenceTriggerRow extends Record<string, unknown> {
  name: string;
  functionSchema: string;
  functionName: string;
  enabled: string;
  internal: boolean;
  constraintOid: string;
  parentOid: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
  argumentsHex: string;
  hasWhen: boolean;
  definition: string;
}

const EXPECTED_FENCE_FUNCTION_HASHES = new Map([
  [
    'enforce_site_vip_binding_safety',
    '8443f54205a59eb6548daab1af2c156f77ef13a216d587a5a999a5091c402916',
  ],
  [
    'enforce_players_vip_lifecycle_owner',
    '35b132da3d8525d8e468f6a260512599f99eb5ed23f83de121893ce1d96a79de',
  ],
  [
    'lock_vip_lifecycle_writer_fence',
    'bf357868365e123759a717ce6d9e4179c872f1b027247c01f6e316983b6e70f0',
  ],
]);

const EXPECTED_FENCE_TRIGGER_DEFINITIONS = new Map([
  [
    'trg_role_squad_permissions_site_vip_guard',
    'CREATE TRIGGER trg_role_squad_permissions_site_vip_guard BEFORE INSERT OR DELETE OR UPDATE ON role_squad_permissions FOR EACH ROW EXECUTE FUNCTION enforce_site_vip_binding_safety()',
  ],
  [
    'trg_roles_site_vip_safety_guard',
    'CREATE TRIGGER trg_roles_site_vip_safety_guard BEFORE UPDATE OF name, panel_access, is_system_role ON roles FOR EACH ROW EXECUTE FUNCTION enforce_site_vip_binding_safety()',
  ],
  [
    'trg_panel_meta_vip_lifecycle_fence_delete',
    'CREATE TRIGGER trg_panel_meta_vip_lifecycle_fence_delete BEFORE DELETE ON panel_meta FOR EACH ROW EXECUTE FUNCTION lock_vip_lifecycle_writer_fence()',
  ],
  [
    'trg_panel_meta_vip_lifecycle_fence_lock',
    'CREATE TRIGGER trg_panel_meta_vip_lifecycle_fence_lock BEFORE UPDATE OF vip_lifecycle_strict ON panel_meta FOR EACH ROW EXECUTE FUNCTION lock_vip_lifecycle_writer_fence()',
  ],
  [
    'trg_players_vip_lifecycle_owner_guard',
    'CREATE TRIGGER trg_players_vip_lifecycle_owner_guard BEFORE INSERT OR UPDATE OF role_id, role_expires_at, role_comment, role_lifecycle_event_id ON players FOR EACH ROW EXECUTE FUNCTION enforce_players_vip_lifecycle_owner()',
  ],
  [
    'trg_roles_vip_lifecycle_safety_guard',
    'CREATE TRIGGER trg_roles_vip_lifecycle_safety_guard BEFORE UPDATE OF panel_access, is_system_role ON roles FOR EACH ROW EXECUTE FUNCTION lock_vip_lifecycle_writer_fence()',
  ],
  [
    'trg_vip_lifecycle_events_writer_fence_lock',
    'CREATE TRIGGER trg_vip_lifecycle_events_writer_fence_lock BEFORE INSERT OR DELETE OR UPDATE ON vip_lifecycle_events FOR EACH ROW EXECUTE FUNCTION lock_vip_lifecycle_writer_fence()',
  ],
  [
    'trg_vip_tiers_writer_fence_lock',
    'CREATE TRIGGER trg_vip_tiers_writer_fence_lock BEFORE INSERT OR DELETE OR UPDATE ON vip_tiers FOR EACH ROW EXECUTE FUNCTION lock_vip_lifecycle_writer_fence()',
  ],
  [
    'trg_vip_tiers_site_binding_guard',
    'CREATE TRIGGER trg_vip_tiers_site_binding_guard BEFORE INSERT OR UPDATE OF name, role_id, default_days, price_bonuses, is_active ON vip_tiers FOR EACH ROW EXECUTE FUNCTION enforce_site_vip_binding_safety()',
  ],
]);

const EXPECTED_FENCE_TRIGGER_FUNCTIONS = new Map([
  ['trg_role_squad_permissions_site_vip_guard', 'enforce_site_vip_binding_safety'],
  ['trg_roles_site_vip_safety_guard', 'enforce_site_vip_binding_safety'],
  ['trg_panel_meta_vip_lifecycle_fence_delete', 'lock_vip_lifecycle_writer_fence'],
  ['trg_panel_meta_vip_lifecycle_fence_lock', 'lock_vip_lifecycle_writer_fence'],
  ['trg_players_vip_lifecycle_owner_guard', 'enforce_players_vip_lifecycle_owner'],
  ['trg_roles_vip_lifecycle_safety_guard', 'lock_vip_lifecycle_writer_fence'],
  ['trg_vip_lifecycle_events_writer_fence_lock', 'lock_vip_lifecycle_writer_fence'],
  ['trg_vip_tiers_writer_fence_lock', 'lock_vip_lifecycle_writer_fence'],
  ['trg_vip_tiers_site_binding_guard', 'enforce_site_vip_binding_safety'],
]);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasExactFunctionMetadata(row: FenceFunctionRow): boolean {
  return (
    row.ownerMatches &&
    row.language === 'plpgsql' &&
    !row.securityDefiner &&
    row.volatility === 'v' &&
    row.config?.length === 1 &&
    row.config[0] === 'search_path=pg_catalog, public' &&
    row.kind === 'f' &&
    row.returnsTrigger &&
    row.argumentCount === 0 &&
    row.parallel === 'u' &&
    !row.leakproof &&
    !row.strict &&
    sha256(row.source) === EXPECTED_FENCE_FUNCTION_HASHES.get(row.name)
  );
}

function hasExactTriggerMetadata(row: FenceTriggerRow): boolean {
  return (
    row.functionSchema === 'public' &&
    row.functionName === EXPECTED_FENCE_TRIGGER_FUNCTIONS.get(row.name) &&
    row.enabled === 'O' &&
    !row.internal &&
    row.constraintOid === '0' &&
    row.parentOid === '0' &&
    !row.deferrable &&
    !row.initiallyDeferred &&
    row.argumentsHex === '' &&
    !row.hasWhen &&
    row.definition === EXPECTED_FENCE_TRIGGER_DEFINITIONS.get(row.name)
  );
}

async function assertVipLifecycleFenceIntegrity(tx: FenceTransaction): Promise<void> {
  const functionRows = (await tx.execute<FenceFunctionRow>(sql`
    SELECT
      proc.proname AS "name",
      pg_get_userbyid(proc.proowner) = current_user AS "ownerMatches",
      language.lanname AS "language",
      proc.prosecdef AS "securityDefiner",
      proc.provolatile AS "volatility",
      proc.proconfig AS "config",
      proc.prokind AS "kind",
      proc.prorettype = 'pg_catalog.trigger'::regtype AS "returnsTrigger",
      proc.pronargs AS "argumentCount",
      proc.proparallel AS "parallel",
      proc.proleakproof AS "leakproof",
      proc.proisstrict AS "strict",
      proc.prosrc AS "source"
    FROM pg_catalog.pg_proc proc
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = proc.pronamespace
    JOIN pg_catalog.pg_language language ON language.oid = proc.prolang
    WHERE namespace.nspname = 'public'
      AND proc.proname IN (
        'enforce_site_vip_binding_safety',
        'lock_vip_lifecycle_writer_fence',
        'enforce_players_vip_lifecycle_owner'
      )
  `)) as unknown as FenceFunctionRow[];
  const triggerRows = (await tx.execute<FenceTriggerRow>(sql`
    SELECT
      trigger.tgname AS "name",
      function_namespace.nspname AS "functionSchema",
      trigger_function.proname AS "functionName",
      trigger.tgenabled AS "enabled",
      trigger.tgisinternal AS "internal",
      trigger.tgconstraint::text AS "constraintOid",
      trigger.tgparentid::text AS "parentOid",
      trigger.tgdeferrable AS "deferrable",
      trigger.tginitdeferred AS "initiallyDeferred",
      encode(trigger.tgargs, 'hex') AS "argumentsHex",
      trigger.tgqual IS NOT NULL AS "hasWhen",
      pg_get_triggerdef(trigger.oid, true) AS "definition"
    FROM pg_catalog.pg_trigger trigger
    JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_proc trigger_function ON trigger_function.oid = trigger.tgfoid
    JOIN pg_catalog.pg_namespace function_namespace
      ON function_namespace.oid = trigger_function.pronamespace
    WHERE namespace.nspname = 'public'
      AND trigger.tgname IN (
        'trg_role_squad_permissions_site_vip_guard',
        'trg_roles_site_vip_safety_guard',
        'trg_players_vip_lifecycle_owner_guard',
        'trg_vip_tiers_site_binding_guard',
        'trg_vip_tiers_writer_fence_lock',
        'trg_roles_vip_lifecycle_safety_guard',
        'trg_vip_lifecycle_events_writer_fence_lock',
        'trg_panel_meta_vip_lifecycle_fence_lock',
        'trg_panel_meta_vip_lifecycle_fence_delete'
      )
  `)) as unknown as FenceTriggerRow[];

  if (
    functionRows.length !== EXPECTED_FENCE_FUNCTION_HASHES.size ||
    triggerRows.length !== EXPECTED_FENCE_TRIGGER_DEFINITIONS.size ||
    functionRows.some(
      (row) => !EXPECTED_FENCE_FUNCTION_HASHES.has(row.name) || !hasExactFunctionMetadata(row),
    ) ||
    triggerRows.some(
      (row) => !EXPECTED_FENCE_TRIGGER_DEFINITIONS.has(row.name) || !hasExactTriggerMetadata(row),
    )
  ) {
    throw new VipLifecycleFenceIntegrityError();
  }
}

async function lockFence(tx: Pick<FenceTransaction, 'execute'>): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('vip-lifecycle-writer-fence', 0))`,
  );
}

async function inspectOwnership(
  tx: FenceTransaction,
  now = new Date(),
): Promise<VipOwnershipAuditResult> {
  const activeAssignments = await tx
    .select({
      id: players.id,
      roleId: players.roleId,
      roleExpiresAt: players.roleExpiresAt,
      roleComment: players.roleComment,
      roleLifecycleEventId: players.roleLifecycleEventId,
    })
    .from(players)
    .where(
      and(
        isNotNull(players.roleId),
        or(isNull(players.roleExpiresAt), gt(players.roleExpiresAt, now)),
        inArray(
          players.id,
          tx
            .select({ playerId: vipLifecycleEvents.playerId })
            .from(vipLifecycleEvents)
            .where(
              and(
                eq(vipLifecycleEvents.action, 'assigned'),
                isNotNull(vipLifecycleEvents.playerId),
                isNotNull(vipLifecycleEvents.appliedAt),
                isNull(vipLifecycleEvents.supersededByEventId),
              ),
            ),
        ),
      ),
    );
  const markedAssignments = await tx
    .select({
      id: players.id,
      roleId: players.roleId,
      roleExpiresAt: players.roleExpiresAt,
      roleComment: players.roleComment,
      roleLifecycleEventId: players.roleLifecycleEventId,
    })
    .from(players)
    .where(isNotNull(players.roleLifecycleEventId));
  const activeTierMappings = await tx
    .select({
      roleId: vipTiers.roleId,
      tierName: vipTiers.name,
      defaultDays: vipTiers.defaultDays,
      priceBonuses: vipTiers.priceBonuses,
      roleName: roles.name,
      panelAccess: roles.panelAccess,
      isSystemRole: roles.isSystemRole,
      squadPermissionKey: roleSquadPermissions.squadPermissionKey,
    })
    .from(vipTiers)
    .innerJoin(roles, eq(roles.id, vipTiers.roleId))
    .innerJoin(roleSquadPermissions, eq(roleSquadPermissions.roleId, vipTiers.roleId))
    .where(eq(vipTiers.isActive, true));
  const mappingsByRole = new Map<string, typeof activeTierMappings>();
  for (const mapping of activeTierMappings) {
    const mappings = mappingsByRole.get(mapping.roleId) ?? [];
    mappings.push(mapping);
    mappingsByRole.set(mapping.roleId, mappings);
  }
  const safeTierRoles = new Set(
    [...mappingsByRole.entries()]
      .filter(
        ([, mappings]) =>
          mappings.length === 1 &&
          mappings[0]?.tierName === 'BSS VIP' &&
          mappings[0]?.defaultDays === null &&
          mappings[0]?.priceBonuses === null &&
          mappings[0]?.roleName === 'QueuePriority' &&
          !mappings[0]?.panelAccess &&
          !mappings[0]?.isSystemRole &&
          mappings[0]?.squadPermissionKey === 'reserve',
      )
      .map(([roleId]) => roleId),
  );

  let orphanedAssignments = 0;
  let conflictingAssignments = 0;
  let lifecycleAssignments = 0;
  // This startup/cutover audit runs rarely; keeping ownership checks in the
  // shared DB helpers is more important than duplicating their SQL model.
  const ownershipEvidence = new Map<string, boolean>();
  for (const assignment of new Map(
    [...activeAssignments, ...markedAssignments].map((assignment) => [assignment.id, assignment]),
  ).values()) {
    ownershipEvidence.set(assignment.id, (await findVipLifecycleOwner(tx, assignment)) !== null);
  }
  for (const assignment of activeAssignments) {
    if (ownershipEvidence.get(assignment.id)) {
      lifecycleAssignments += 1;
      continue;
    }
    if (await findCurrentVipLifecycleAssignment(tx, assignment)) {
      lifecycleAssignments += 1;
      orphanedAssignments += 1;
    }
  }
  for (const assignment of markedAssignments) {
    if (
      !ownershipEvidence.get(assignment.id) ||
      !assignment.roleId ||
      !safeTierRoles.has(assignment.roleId)
    ) {
      conflictingAssignments += 1;
    }
  }

  return {
    activeAssignments: lifecycleAssignments,
    orphanedAssignments,
    conflictingAssignments,
  };
}

export async function auditVipLifecycleOwnershipState(
  db: DatabaseClient,
): Promise<VipOwnershipAuditResult> {
  return db.transaction(async (tx) => {
    await lockFence(tx);
    await assertVipLifecycleFenceIntegrity(tx);
    return inspectOwnership(tx);
  });
}

export async function enableVipLifecycleFence(
  db: DatabaseClient,
): Promise<VipOwnershipAuditResult> {
  return db.transaction(async (tx) => {
    await lockFence(tx);
    await assertVipLifecycleFenceIntegrity(tx);
    const result = await inspectOwnership(tx);
    if (result.orphanedAssignments > 0 || result.conflictingAssignments > 0) {
      throw new VipLifecycleOwnershipAuditError(result);
    }
    const [updated] = await tx
      .update(panelMeta)
      .set({ vipLifecycleStrict: true })
      .where(eq(panelMeta.id, 1))
      .returning({ id: panelMeta.id });
    if (!updated) throw new Error('panel_meta singleton is missing');
    return result;
  });
}

export async function disableVipLifecycleFence(db: DatabaseClient): Promise<void> {
  await db.transaction(async (tx) => {
    await lockFence(tx);
    await tx.execute(sql`SELECT set_config('squad.vip_lifecycle_fence_rollback', 'on', true)`);
    const [updated] = await tx
      .update(panelMeta)
      .set({ vipLifecycleStrict: false })
      .where(eq(panelMeta.id, 1))
      .returning({ id: panelMeta.id });
    if (!updated) throw new Error('panel_meta singleton is missing');
  });
}

export async function ensureVipLifecycleFenceAtStartup(
  db: DatabaseClient,
  requireRevision: boolean,
): Promise<void> {
  if (requireRevision) {
    await enableVipLifecycleFence(db);
    return;
  }

  await db.transaction(async (tx) => {
    await lockFence(tx);
    await assertVipLifecycleFenceIntegrity(tx);
    const [state] = await tx
      .select({ enabled: panelMeta.vipLifecycleStrict })
      .from(panelMeta)
      .where(eq(panelMeta.id, 1))
      .limit(1);
    if (!state) throw new Error('panel_meta singleton is missing');
    if (state.enabled) throw new VipLifecycleFenceModeError();
  });
}
