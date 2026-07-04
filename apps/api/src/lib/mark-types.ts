import type { DatabaseClient } from '@squad/db';
import { markTypes } from '@squad/db/schema';

export const MARK_TYPE_ICONS = [
  'scan-eye',
  'crosshair',
  'gauge',
  'boxes',
  'refresh-cw',
  'skull',
  'file-warning',
  'message-square-warning',
  'flag',
  'shield-alert',
  'bug',
  'ban',
  'alert-triangle',
  'eye-off',
  'radar',
  'zap',
] as const;

export type MarkTypeIcon = (typeof MARK_TYPE_ICONS)[number];

const MARK_TYPE_ICON_SET: ReadonlySet<string> = new Set(MARK_TYPE_ICONS);

export const MARK_TYPE_SEVERITY_MIN = 1;
export const MARK_TYPE_SEVERITY_MAX = 5;

export function isMarkTypeIcon(value: string): value is MarkTypeIcon {
  return MARK_TYPE_ICON_SET.has(value);
}

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
    .onConflictDoNothing({ target: markTypes.id });
}
