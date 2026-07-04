export interface MarkTypeOption {
  id: number;
  slug: string;
  label_en: string;
  label_ru: string;
  icon: string;
  severity: number;
  sort_order: number;
}

export interface MarkTypeMini {
  mark_type_id: number;
  slug: string;
  label_en: string;
  label_ru: string;
  icon: string;
  severity: number;
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

export interface MarkMenuItem {
  type: MarkTypeOption;
  activeMark: PlayerMark | null;
}

export type MarkTone = 'red' | 'amber' | 'neutral';

const ICON_EMOJI: Record<string, string> = {
  'scan-eye': '👁️',
  crosshair: '🎯',
  gauge: '💨',
  boxes: '📦',
  'refresh-cw': '🔄',
  skull: '💀',
  'file-warning': '🛠️',
  'message-square-warning': '🗯️',
};

export function markIconEmoji(icon: string): string {
  return ICON_EMOJI[icon] ?? '🚩';
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

export function markTypeMenuItems(
  allTypes: MarkTypeOption[],
  activeMarks: PlayerMark[],
): MarkMenuItem[] {
  const activeByType = new Map(activeMarks.map((mark) => [mark.mark_type_id, mark]));
  return [...allTypes]
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((type) => ({ type, activeMark: activeByType.get(type.id) ?? null }));
}

export function severityTone(severity: number): MarkTone {
  if (severity >= 5) return 'red';
  if (severity >= 3) return 'amber';
  return 'neutral';
}

export function highestSeverityTone(marks: Array<{ severity: number }>): MarkTone | null {
  if (marks.length === 0) return null;
  const top = marks.reduce((max, mark) => Math.max(max, mark.severity), 0);
  return severityTone(top);
}
