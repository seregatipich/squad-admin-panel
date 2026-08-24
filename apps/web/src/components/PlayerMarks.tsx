'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  formatAbsolute,
  InlineBanner,
  Menu,
  type MenuItem,
  StatusDot,
  type StatusState,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { useIntlLocale } from '@/i18n/LocaleProvider';
import type { LiveEvent } from '@/lib/live-bus';
import {
  type MarkTone,
  type MarkTypeOption,
  markIconEmoji,
  markTypeMenuItems,
  type PlayerMark,
  partitionMarks,
  severityTone,
} from '@/lib/marks';
import { useLiveSubscription } from '@/lib/use-live-bus';

/** Тяжесть метки — состояние игрока, и точка состояния читает его тоном (§5). */
const MARK_STATE: Record<MarkTone, StatusState> = {
  red: 'crit',
  amber: 'warn',
  neutral: 'idle',
};

const MARK_STATE_LABEL: Record<MarkTone, string> = {
  red: 'высокая тяжесть',
  amber: 'средняя тяжесть',
  neutral: 'низкая тяжесть',
};

function formatWhen(iso: string | null, locale: string): string {
  if (!iso) return '—';
  return formatAbsolute(iso, locale) ?? '—';
}

export function PlayerMarks({ playerId }: { playerId: string }) {
  const locale = useIntlLocale();
  const [types, setTypes] = useState<MarkTypeOption[]>([]);
  const [marks, setMarks] = useState<PlayerMark[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingClear, setPendingClear] = useState<PlayerMark | null>(null);

  const reload = useCallback(async () => {
    const [typesRes, marksRes] = await Promise.all([
      fetch('/api/v1/mark-types', { credentials: 'include', cache: 'no-store' }),
      fetch(`/api/v1/players/${playerId}/marks?include_cleared=true`, {
        credentials: 'include',
        cache: 'no-store',
      }),
    ]);
    if (typesRes.ok) setTypes((await typesRes.json()) as MarkTypeOption[]);
    if (marksRes.ok) {
      const body = (await marksRes.json()) as { items: PlayerMark[] };
      setMarks(body.items);
    }
  }, [playerId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onLiveChange = useCallback(
    (event: Extract<LiveEvent, { type: 'mark.changed' }>) => {
      if (event.data.player_id !== playerId) return;
      void reload();
    },
    [playerId, reload],
  );
  useLiveSubscription('mark.changed', onLiveChange);

  const { active } = partitionMarks(marks);

  async function setMark(type: MarkTypeOption) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const optimistic: PlayerMark = {
      id: `optimistic-${type.id}-${Date.now()}`,
      player_id: playerId,
      mark_type_id: type.id,
      comment: null,
      created_by: '',
      created_by_name: null,
      created_at: new Date().toISOString(),
      cleared_by: null,
      cleared_by_name: null,
      cleared_at: null,
      clear_reason: null,
      active: true,
      mark_type: {
        id: type.id,
        slug: type.slug,
        label_en: type.label_en,
        label_ru: type.label_ru,
        icon: type.icon,
        severity: type.severity,
      },
    };
    setMarks((prev) => [optimistic, ...prev]);
    try {
      const res = await fetch(`/api/v1/players/${playerId}/marks`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mark_type_id: type.id }),
      });
      if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await reload();
      setBusy(false);
    }
  }

  async function clearMark(mark: PlayerMark) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMarks((prev) =>
      prev.map((entry) => (entry.id === mark.id ? { ...entry, active: false } : entry)),
    );
    try {
      const res = await fetch(`/api/v1/players/${playerId}/marks/${mark.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPendingClear(null);
      await reload();
      setBusy(false);
    }
  }

  // Меню объявлено как меню и ведёт себя как меню: примитив даёт `role="menu"`,
  // ходьбу стрелками, Home/End, Escape и возврат фокуса на триггер.
  const menuItems: MenuItem[] = markTypeMenuItems(types, active).map(({ type, activeMark }) => ({
    kind: 'action',
    disabled: busy,
    hint: type.label_en,
    label: (
      <>
        <span aria-hidden>{markIconEmoji(type.icon)}</span>
        <span>{type.label_ru}</span>
        {activeMark ? <span className="text-2xs text-ink-3">— снять</span> : null}
      </>
    ),
    onSelect: () => {
      if (activeMark) setPendingClear(activeMark);
      else void setMark(type);
    },
  }));

  return (
    <Card padding="none" as="section">
      <CardHeader
        title="Метки подозрения"
        count={active.length}
        actions={
          <Menu
            trigger={{ label: 'Метки', ariaLabel: 'Метки подозрения' }}
            items={menuItems}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            align="end"
          />
        }
      />

      <CardBody className="space-y-3">
        {error ? (
          <InlineBanner tone="crit" title="Не удалось изменить метки" description={error} />
        ) : null}

        {active.length > 0 ? (
          <ul className="divide-y divide-line rounded-ctl border border-line">
            {active.map((mark) => {
              const tone = severityTone(mark.mark_type.severity);
              return (
                <li key={mark.id} className="flex items-start justify-between gap-3 p-2">
                  <div className="flex items-start gap-2">
                    <span className="mt-1">
                      <StatusDot
                        state={MARK_STATE[tone]}
                        label={MARK_STATE_LABEL[tone]}
                        hideLabel
                      />
                    </span>
                    <span aria-hidden className="text-base leading-none">
                      {markIconEmoji(mark.mark_type.icon)}
                    </span>
                    <div>
                      <div className="text-[13px] font-medium text-ink">
                        {mark.mark_type.label_ru}
                        <span className="ml-1 text-2xs font-normal text-ink-3">
                          {mark.mark_type.label_en}
                        </span>
                      </div>
                      <div className="text-2xs text-ink-3">
                        поставил {mark.created_by_name ?? '—'} ·{' '}
                        {formatWhen(mark.created_at, locale)}
                      </div>
                      {mark.comment ? (
                        <div className="mt-0.5 text-xs text-ink-2">{mark.comment}</div>
                      ) : null}
                    </div>
                  </div>
                  <Button size="sm" disabled={busy} onClick={() => setPendingClear(mark)}>
                    Снять
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            title="Активных меток нет"
            description="Ни одна метка подозрения на игроке сейчас не стоит."
          />
        )}

        <details>
          <summary className="cursor-pointer text-xs text-ink-3">
            История меток ({marks.length})
          </summary>
          {marks.length === 0 ? (
            <p className="mt-2 text-xs text-ink-3">История пуста.</p>
          ) : (
            <div className="mt-2">
              <Table dense ariaLabel="История меток игрока">
                <TableHead sticky={false}>
                  <tr>
                    <Th>Тип</Th>
                    <Th>Поставил</Th>
                    <Th>Снял</Th>
                    <Th>Причина</Th>
                  </tr>
                </TableHead>
                <TableBody>
                  {marks.map((mark) => (
                    <TableRow key={mark.id}>
                      <Td className="align-top">
                        <span aria-hidden className="mr-1">
                          {markIconEmoji(mark.mark_type.icon)}
                        </span>
                        <span className={mark.active ? 'text-ink' : 'text-ink-3'}>
                          {mark.mark_type.label_ru}
                        </span>
                      </Td>
                      <Td className="align-top text-ink-2">
                        {mark.created_by_name ?? '—'}
                        <div className="text-ink-3">{formatWhen(mark.created_at, locale)}</div>
                      </Td>
                      <Td className="align-top text-ink-2">
                        {mark.active ? (
                          <Badge tone="good" size="sm">
                            активна
                          </Badge>
                        ) : (
                          <>
                            {mark.cleared_by_name ?? '—'}
                            <div className="text-ink-3">{formatWhen(mark.cleared_at, locale)}</div>
                          </>
                        )}
                      </Td>
                      <Td className="align-top text-ink-2">{mark.clear_reason ?? '—'}</Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </details>
      </CardBody>

      <AlertDialog
        open={pendingClear !== null}
        onClose={() => setPendingClear(null)}
        title="Снять метку"
        body={
          <>
            Метка «{pendingClear?.mark_type.label_ru}» перестанет быть активной. Запись останется в
            истории меток.
          </>
        }
        confirmLabel="Снять метку"
        cancelLabel="Отмена"
        tone="default"
        busy={busy && pendingClear !== null}
        onConfirm={() => {
          if (pendingClear) void clearMark(pendingClear);
        }}
      />
    </Card>
  );
}
