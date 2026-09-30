/**
 * Russian labels and badge tones for `moderation_actions.action_type`, shared
 * by the player card and the teamkill browser so a machine code never reaches
 * the Russian-only UI (#455) and there is one type→style map (#473).
 */
import type { BadgeTone } from '@/components/ui';

/**
 * `moderation_actions.action_type` is free text with no CHECK constraint —
 * these are the values actually written today (the panel's own warn/kick/ban/
 * unban, plus the banname, external-ban and clan-guard workers). Anything else
 * falls through to the raw value rather than being hidden behind a placeholder.
 */
const ACTION_LABELS: Record<string, string> = {
  warn: 'Предупреждение',
  kick: 'Кик',
  ban: 'Бан',
  unban: 'Разбан',
  name_kick: 'Кик за ник',
  external_ban_kick: 'Кик по внешнему бану',
  'external_ban.local_ban': 'Локальный бан по внешнему',
  clan_tag_protection: 'Защита клан-тега',
};

export function moderationActionLabel(actionType: string): string {
  return ACTION_LABELS[actionType] ?? actionType;
}

/**
 * Тяжесть действия модерации для `<Badge tone>` — единственная карта «тип
 * действия → оформление». Подпись из {@link moderationActionLabel} всё равно
 * называет действие словом, тон лишь помогает найти взглядом бан среди
 * предупреждений (§5). Неизвестный тип получает нейтральный тон.
 */
const ACTION_TONES: Record<string, BadgeTone> = {
  warn: 'warn',
  kick: 'warn',
  ban: 'crit',
  unban: 'good',
  name_kick: 'warn',
  external_ban_kick: 'warn',
  'external_ban.local_ban': 'crit',
  clan_tag_protection: 'accent',
};

export function moderationActionTone(actionType: string): BadgeTone {
  return ACTION_TONES[actionType] ?? 'neutral';
}
