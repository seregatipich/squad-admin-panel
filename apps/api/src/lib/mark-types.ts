import type { DatabaseClient } from '@squad/db';
import { markTypes } from '@squad/db/schema';
import {
  MARK_TYPE_ICONS,
  MARK_TYPE_SEVERITY_MAX,
  MARK_TYPE_SEVERITY_MIN,
  type MarkTypeIcon,
} from '@squad/shared-config/mark-types';

export { MARK_TYPE_ICONS, MARK_TYPE_SEVERITY_MAX, MARK_TYPE_SEVERITY_MIN, type MarkTypeIcon };

const MARK_TYPE_ICON_SET: ReadonlySet<string> = new Set(MARK_TYPE_ICONS);

export function isMarkTypeIcon(value: string): value is MarkTypeIcon {
  return MARK_TYPE_ICON_SET.has(value);
}

/**
 * Ids `1..MARK_TYPE_SEED_ID_CEILING` are reserved for {@link MARK_TYPE_SEEDS};
 * operator-created types are numbered above it, so a seed added by a later
 * release never collides with a custom type's id.
 */
export const MARK_TYPE_SEED_ID_CEILING = 100;

/** Unique index on `mark_types.slug`; tells a slug clash from any other 23505. */
export const MARK_TYPE_SLUG_CONSTRAINT = 'mark_types_slug_key';

/** `pg_advisory_xact_lock` key that serialises `POST /api/v1/mark-types`. */
export const MARK_TYPE_CREATE_LOCK = 'mark_types_create';

export interface MarkTypeSeed {
  id: number;
  slug: string;
  labelEn: string;
  labelRu: string;
  icon: string;
  severity: number;
  sortOrder: number;
}

export const MARK_TYPE_SEEDS: readonly MarkTypeSeed[] = [
  {
    id: 1,
    slug: 'wallhack',
    labelEn: 'WallHack',
    labelRu: 'Вижу сквозь стены',
    icon: 'scan-eye',
    severity: 5,
    sortOrder: 1,
  },
  {
    id: 2,
    slug: 'aimbot',
    labelEn: 'AimBot',
    labelRu: 'Аимбот',
    icon: 'crosshair',
    severity: 5,
    sortOrder: 2,
  },
  {
    id: 3,
    slug: 'speedhack',
    labelEn: 'SpeedHack',
    labelRu: 'Спидхак',
    icon: 'gauge',
    severity: 4,
    sortOrder: 3,
  },
  {
    id: 4,
    slug: 'object_spawn',
    labelEn: 'Object Spawn',
    labelRu: 'Спавн объектов',
    icon: 'boxes',
    severity: 4,
    sortOrder: 4,
  },
  {
    id: 5,
    slug: 'reload_exploit',
    labelEn: 'Reload Exploit',
    labelRu: 'Эксплойт перезарядки',
    icon: 'refresh-cw',
    severity: 3,
    sortOrder: 5,
  },
  {
    id: 6,
    slug: 'griefing',
    labelEn: 'Griefing',
    labelRu: 'Грифинг',
    icon: 'skull',
    severity: 2,
    sortOrder: 6,
  },
  {
    id: 7,
    slug: 'illegal_config',
    labelEn: 'Illegal Config',
    labelRu: 'Нелегальный конфиг',
    icon: 'file-warning',
    severity: 3,
    sortOrder: 7,
  },
  {
    id: 8,
    slug: 'toxic',
    labelEn: 'Toxicity',
    labelRu: 'Токсичность',
    icon: 'message-square-warning',
    severity: 1,
    sortOrder: 8,
  },
];

/**
 * Inserts any missing {@link MARK_TYPE_SEEDS}. Rows that already exist — by id
 * or by slug — are left untouched, so operator edits survive restarts and a
 * slug an operator already used never aborts API startup.
 */
export async function ensureMarkTypes(db: DatabaseClient): Promise<void> {
  await db
    .insert(markTypes)
    .values(
      MARK_TYPE_SEEDS.map((seed) => ({
        id: seed.id,
        slug: seed.slug,
        labelEn: seed.labelEn,
        labelRu: seed.labelRu,
        icon: seed.icon,
        severity: seed.severity,
        sortOrder: seed.sortOrder,
      })),
    )
    .onConflictDoNothing();
}
