export interface MarkTypeOption {
  id: number;
  slug: string;
  label_en: string;
  label_ru: string;
  icon: string;
  severity: number;
  sort_order: number;
}

export interface PlayerMark {
  id: string;
  player_id: string;
  mark_type_id: number;
  comment: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  cleared_by: string | null;
  cleared_by_name: string | null;
  cleared_at: string | null;
  clear_reason: string | null;
  active: boolean;
  mark_type: {
    id: number;
    slug: string;
    label_en: string;
    label_ru: string;
    icon: string;
    severity: number;
  };
}

export function partitionMarks(marks: PlayerMark[]): {
  active: PlayerMark[];
  cleared: PlayerMark[];
} {
  const active: PlayerMark[] = [];
  const cleared: PlayerMark[] = [];
  for (const mark of marks) {
    if (mark.active) {
      active.push(mark);
    } else {
      cleared.push(mark);
    }
  }
  return { active, cleared };
}

export function availableMarkTypes(
  allTypes: MarkTypeOption[],
  activeMarks: PlayerMark[],
): MarkTypeOption[] {
  const usedTypeIds = new Set(activeMarks.map((mark) => mark.mark_type_id));
  return allTypes
    .filter((type) => !usedTypeIds.has(type.id))
    .sort((left, right) => left.sort_order - right.sort_order);
}

export function severityTone(severity: number): string {
  if (severity >= 5) return 'red';
  if (severity >= 3) return 'amber';
  return 'neutral';
}
