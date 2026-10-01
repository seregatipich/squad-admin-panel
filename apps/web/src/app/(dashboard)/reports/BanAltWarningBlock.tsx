import { Badge, Checkbox, InlineBanner, Skeleton } from '@/components/ui';
import type { BanAltWarning } from './report-types';

export function BanAltWarningBlock({
  warning,
  loading,
  error,
  selectedAltIds,
  onToggleAlt,
}: {
  warning: BanAltWarning | null;
  loading: boolean;
  error: string | null;
  selectedAltIds: string[];
  onToggleAlt: (playerId: string) => void;
}) {
  if (loading) return <Skeleton variant="text" count={2} label="Проверка связанных аккаунтов" />;
  if (error) {
    return (
      <InlineBanner
        tone="warn"
        title={`Проверка альтов недоступна (${error}). Бан можно продолжить.`}
      />
    );
  }
  if (!warning) return null;
  if (!warning.can_view_ips) {
    return warning.confirmed_count > 0 ? (
      <InlineBanner
        tone="warn"
        title={`У игрока есть ${warning.confirmed_count} подтверждённых связанных аккаунтов.`}
      />
    ) : null;
  }
  if (warning.confirmed.length === 0 && warning.candidates.length === 0) return null;

  return (
    /* Предупреждающая поверхность вместо `InlineBanner`: внутри живут флажки,
       а `warn` у полосы означает `role="alert"` — интерактивный список в
       живой области объявлялся бы целиком при каждом переключении. */
    <div className="space-y-3 rounded-card border border-warn/40 bg-warn/10 p-3">
      <h3 className="text-[13px] font-semibold text-ink">У игрока есть связанные аккаунты</h3>
      {warning.confirmed.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-ink-2">Подтверждённые связи</p>
          {warning.confirmed.map((alt) => (
            <Checkbox
              key={alt.player_id}
              checked={selectedAltIds.includes(alt.player_id)}
              onChange={() => onToggleAlt(alt.player_id)}
              label={
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <span>{alt.name}</span>
                  <span className="text-ink-3">({alt.link_type ?? 'alt'})</span>
                  {alt.online ? <Badge tone="good">онлайн</Badge> : null}
                  {alt.has_active_ban ? <Badge tone="crit">активный бан</Badge> : null}
                  <span className="text-ink-3">— забанить также</span>
                </span>
              }
            />
          ))}
        </div>
      ) : null}
      {warning.candidates.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-ink-2">Кандидаты с высокой уверенностью</p>
          {warning.candidates.map((candidate) => (
            <p
              key={candidate.player_id}
              className="flex flex-wrap items-center gap-1.5 text-xs text-ink-2"
            >
              <span>{candidate.name}</span>
              <span className="text-ink-3">(уверенность: высокая)</span>
              {candidate.online ? <Badge tone="good">онлайн</Badge> : null}
              {candidate.has_active_ban ? <Badge tone="crit">активный бан</Badge> : null}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
