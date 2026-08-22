'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FieldRow,
  GroupedList,
  GroupedRow,
  InlineBanner,
  PageContainer,
  PageHeader,
  SegmentedControl,
  Select,
  SkeletonTable,
  Switch,
  Table,
  TableBody,
  TableHead,
  TableRow,
  type TableRowTone,
  Td,
  TextInput,
  Th,
  Toolbar,
} from '@/components/ui';
import {
  type BalancerFilters,
  balancerViewState,
  buildProposalsQuery,
  DEFAULT_BALANCER_FILTERS,
  decisionLabel,
  formatTeam,
  type ProposalTone,
  proposalStateLabel,
  proposalStateTone,
  proposalStatusLabel,
  subjectTypeLabel,
  summarizeStates,
  triggerReasonLabel,
} from './helpers';

const POLL_INTERVAL_MS = 8000;

interface TriggerReason {
  kind: string;
  observed: number;
  threshold: number;
}

interface DiffEntry {
  subject_type: string;
  subject_id: string;
  label: string;
  current_team: number | null;
  target_team: number | null;
  state: string;
}

interface ProposalItem {
  id: string;
  source_snapshot_id: string;
  server_id: string;
  layer: string | null;
  gamemode: string | null;
  mode: string;
  status: string;
  generated_at: string;
  signals: Record<string, unknown>;
  proposal: DiffEntry[];
  evaluation: { triggered: boolean; reasons: TriggerReason[] };
}

interface DecisionRow {
  id: string;
  decision: string;
  veto_reason_kind: string | null;
  veto_reason: string | null;
  created_at: string;
}

interface ProposalDetail extends ProposalItem {
  decisions: DecisionRow[];
}

interface SettingsView {
  enabled: boolean;
  win_streak_threshold: number;
  ticket_diff_threshold: number;
  one_sided_rounds_threshold: number;
  quorum: number;
  pass_threshold_pct: number;
  require_moderator_veto: boolean;
  prefer_squad_grouping: boolean;
  player_level_enabled: boolean;
}

const DEFAULT_SETTINGS: SettingsView = {
  enabled: false,
  win_streak_threshold: 3,
  ticket_diff_threshold: 150,
  one_sided_rounds_threshold: 2,
  quorum: 5,
  pass_threshold_pct: 60,
  require_moderator_veto: false,
  prefer_squad_grouping: true,
  player_level_enabled: false,
};

const NUMBER_FIELDS: ReadonlyArray<{ key: keyof SettingsView; label: string; hint: string }> = [
  { key: 'win_streak_threshold', label: 'Серия побед', hint: 'от 1' },
  { key: 'ticket_diff_threshold', label: 'Разница тикетов', hint: 'от 0' },
  { key: 'one_sided_rounds_threshold', label: 'Односторонних раундов', hint: 'от 1' },
  { key: 'quorum', label: 'Кворум голосования', hint: 'от 0' },
  { key: 'pass_threshold_pct', label: 'Порог прохождения, %', hint: '0–100' },
];

const FLAG_FIELDS: ReadonlyArray<{ key: keyof SettingsView; label: string }> = [
  { key: 'enabled', label: 'Балансировщик включён' },
  { key: 'require_moderator_veto', label: 'Требуется вето модератора' },
  { key: 'prefer_squad_grouping', label: 'Сохранять отряды целиком' },
  { key: 'player_level_enabled', label: 'Разрешить режим по игрокам' },
];

const VETO_REASON_KINDS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'seeding', label: 'Сидинг' },
  { value: 'event', label: 'Ивент' },
  { value: 'clan_match', label: 'Клановый матч' },
  { value: 'other', label: 'Другое' },
];

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Любой статус' },
  { value: 'open', label: 'Новое' },
  { value: 'reviewed', label: 'Рассмотрено' },
  { value: 'dismissed', label: 'Отклонено' },
  { value: 'superseded', label: 'Устарело' },
];

/**
 * Пояснение под панелью фильтров. Состояния `loading` здесь нет намеренно:
 * загрузка показывается заглушкой в форме таблицы, а не строкой «Загрузка…»
 * (дизайн-система, §8).
 */
const VIEW_STATE_NOTES: Record<string, string> = {
  empty:
    'Снимков от экспортёра ещё не поступало. Страница работает — как только SquadJS пришлёт первый снимок, он появится здесь.',
  healthy: 'Признаков дисбаланса нет: ни один сигнал не достиг порога.',
  imbalance: 'Есть снимки с превышением порогов — проверьте предложения ниже.',
};

/**
 * Приглушённый тон строки предложения. Строка, которую предлагают перевести, —
 * это работа для оператора, а не поломка системы, поэтому она `warn`, а не
 * `crit`. Смысл всё равно несёт подпись состояния в последней ячейке (§5).
 */
const DIFF_ROW_TONE: Record<ProposalTone, TableRowTone> = {
  red: 'warn',
  neutral: 'default',
  emerald: 'default',
};

function signalValue(signals: Record<string, unknown>, key: string): string {
  const value = signals[key];
  return typeof value === 'number' ? String(value) : '—';
}

/**
 * Client half of `/balancer` (GAME-2, #81): the dry-run proposal review table
 * and the threshold rules form.
 *
 * Proposals are polled every 8 s, matching `players/page.tsx`; a live-bus event
 * would need the `LiveEvent` union extended in lockstep on both sides and is
 * deliberately left out of v1. Состояние строки диффа выводится исключительно
 * из `proposalStateTone`, поэтому увиденное оператором — чистая функция от
 * поля `state` в ответе, а не от свободного текста.
 *
 * Every control here writes to the panel's own database only — there is no
 * button that moves a player on a live server.
 */
export function BalancerBrowser({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<ProposalItem[]>([]);
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [settings, setSettings] = useState<SettingsView>(DEFAULT_SETTINGS);
  const [filters, setFilters] = useState<BalancerFilters>(DEFAULT_BALANCER_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [vetoReasonKind, setVetoReasonKind] = useState('other');
  const [vetoReason, setVetoReason] = useState('');

  const loadSettings = useCallback(async () => {
    const res = await fetch('/api/v1/balancer/settings', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { settings: SettingsView };
    setSettings(body.settings);
  }, []);

  const loadProposals = useCallback(async () => {
    const res = await fetch(`/api/v1/balancer/proposals?${buildProposalsQuery(filters)}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { items: ProposalItem[] };
    setItems(body.items);
  }, [filters]);

  const refresh = useCallback(async () => {
    try {
      await Promise.all([loadSettings(), loadProposals()]);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadSettings, loadProposals]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const openDetail = useCallback(async (id: string) => {
    setFailure(null);
    try {
      const res = await fetch(`/api/v1/balancer/proposals/${id}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail((await res.json()) as ProposalDetail);
    } catch (e) {
      setFailure((e as Error).message);
    }
  }, []);

  async function saveSettings() {
    setNotice(null);
    setFailure(null);
    try {
      const res = await fetch('/api/v1/balancer/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { settings: SettingsView };
      setSettings(body.settings);
      setNotice('Правила сохранены');
      await loadProposals();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }

  async function decide(decision: string) {
    if (!detail) return;
    setNotice(null);
    setFailure(null);
    try {
      const res = await fetch(`/api/v1/balancer/proposals/${detail.id}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision,
          veto_reason_kind: vetoReasonKind,
          veto_reason: vetoReason.trim() || undefined,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setNotice(`Решение сохранено: ${decisionLabel(decision)}`);
      setVetoReason('');
      await Promise.all([loadProposals(), openDetail(detail.id)]);
    } catch (e) {
      setFailure((e as Error).message);
    }
  }

  const viewState = balancerViewState({ loading, error, items });

  return (
    <PageContainer>
      <PageHeader
        title="Балансировщик команд"
        subtitle="Предложения по балансу приходят из SquadJS в режиме dry-run. Панель показывает их для разбора и хранит решения операторов — принудительный перевод игроков отсюда не выполняется."
      />

      {error ? (
        <InlineBanner tone="crit" title="Не удалось загрузить данные" description={error} />
      ) : null}
      {failure ? (
        <InlineBanner tone="crit" title="Действие не выполнено" description={failure} />
      ) : null}
      {notice ? <InlineBanner tone="good" title={notice} /> : null}

      <section className="space-y-3">
        <h2 className="text-[17px] font-semibold text-ink">Правила</h2>

        <Card>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {NUMBER_FIELDS.map((field) => (
              <FieldRow key={field.key} label={field.label} hint={field.hint}>
                <TextInput
                  type="number"
                  disabled={!canEdit}
                  value={String(settings[field.key])}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      [field.key]: Number.parseInt(e.target.value, 10) || 0,
                    }))
                  }
                />
              </FieldRow>
            ))}
          </div>
        </Card>

        <GroupedList headingLevel={3}>
          {FLAG_FIELDS.map((field) => (
            <GroupedRow
              key={field.key}
              label={field.label}
              control={
                <Switch
                  label={field.label}
                  disabled={!canEdit}
                  checked={Boolean(settings[field.key])}
                  onChange={(next) => setSettings((prev) => ({ ...prev, [field.key]: next }))}
                />
              }
            />
          ))}
        </GroupedList>

        <div className="flex justify-end">
          <Button variant="primary" disabled={!canEdit} onClick={() => void saveSettings()}>
            Сохранить правила
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-[17px] font-semibold text-ink">Предложения</h2>

        <Toolbar
          filters={
            <>
              <SegmentedControl
                ariaLabel="Уровень предложений"
                items={[
                  { value: 'squad', label: 'По отрядам' },
                  {
                    value: 'player',
                    label: 'По игрокам',
                    disabled: !settings.player_level_enabled,
                  },
                ]}
                value={filters.mode}
                onChange={(mode) => setFilters((prev) => ({ ...prev, mode }))}
              />
              <Select
                aria-label="Статус снимка"
                value={filters.status}
                onChange={(e) => setFilters((prev) => ({ ...prev, status: e.target.value }))}
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </>
          }
          summary="Обновление каждые 8 с"
        />

        {VIEW_STATE_NOTES[viewState] ? (
          <p className="text-xs text-ink-3">{VIEW_STATE_NOTES[viewState]}</p>
        ) : null}

        <Card padding="none">
          {loading && items.length === 0 ? (
            <div className="p-3">
              <SkeletonTable rows={6} cols={6} label="Загрузка предложений балансировщика" />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              variant={filters.status === '' ? 'initial' : 'filtered'}
              title="Нет снимков по фильтру"
              description="Ни один снимок не подходит под выбранный уровень и статус."
            />
          ) : (
            <Table ariaLabel="Предложения балансировщика">
              <TableHead>
                <tr>
                  <Th>Снимок</Th>
                  <Th>Слой и режим</Th>
                  <Th>Сигналы</Th>
                  <Th align="right">Изменения</Th>
                  <Th>Статус</Th>
                  <Th>
                    <span className="sr-only">Действия</span>
                  </Th>
                </tr>
              </TableHead>
              <TableBody>
                {items.map((item) => {
                  const counts = summarizeStates(item.proposal);
                  return (
                    <TableRow key={item.id}>
                      <Td>
                        <span className="block text-xs">{item.source_snapshot_id}</span>
                        <span className="block text-2xs text-ink-3">
                          {new Date(item.generated_at).toLocaleString('ru-RU')}
                        </span>
                      </Td>
                      <Td>
                        <span className="block">{item.layer ?? '—'}</span>
                        <span className="block text-xs text-ink-3">{item.gamemode ?? '—'}</span>
                      </Td>
                      <Td>
                        {item.evaluation.reasons.map((reason) => (
                          <span key={reason.kind} className="block text-xs text-warn">
                            {triggerReasonLabel(reason)}
                          </span>
                        ))}
                        {item.evaluation.triggered ? null : (
                          <span className="text-xs text-good">В норме</span>
                        )}
                      </Td>
                      <Td numeric className="text-xs">
                        <span className="text-warn">
                          {counts.should_move}
                          <span className="sr-only"> к переводу</span>
                        </span>
                        <span aria-hidden="true" className="text-ink-4">
                          {' / '}
                        </span>
                        <span className="text-ink-2">
                          {counts.no_change}
                          <span className="sr-only"> без изменений</span>
                        </span>
                        <span aria-hidden="true" className="text-ink-4">
                          {' / '}
                        </span>
                        <span className="text-good">
                          {counts.on_target}
                          <span className="sr-only"> на нужной стороне</span>
                        </span>
                      </Td>
                      <Td>{proposalStatusLabel(item.status)}</Td>
                      <Td>
                        <Button size="sm" onClick={() => void openDetail(item.id)}>
                          Разобрать
                        </Button>
                      </Td>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Card>
      </section>

      {detail ? (
        <Card padding="none">
          <CardHeader
            title={`Снимок ${detail.source_snapshot_id}`}
            actions={
              <Button size="sm" onClick={() => setDetail(null)}>
                Закрыть
              </Button>
            }
          />
          <CardBody className="space-y-4">
            <dl className="grid gap-3 sm:grid-cols-3">
              <Signal label="Серия побед" value={signalValue(detail.signals, 'win_streak')} />
              <Signal label="Разница тикетов" value={signalValue(detail.signals, 'ticket_diff')} />
              <Signal
                label="Односторонних раундов"
                value={signalValue(detail.signals, 'one_sided_rounds')}
              />
            </dl>

            <div className="rounded-card border border-line">
              <Table ariaLabel={`Предложенные изменения снимка ${detail.source_snapshot_id}`}>
                <TableHead sticky={false}>
                  <tr>
                    <Th>Субъект</Th>
                    <Th>Сейчас</Th>
                    <Th>Предлагается</Th>
                    <Th>Состояние</Th>
                  </tr>
                </TableHead>
                <TableBody>
                  {detail.proposal.map((entry) => (
                    <TableRow
                      key={`${entry.subject_type}:${entry.subject_id}`}
                      tone={DIFF_ROW_TONE[proposalStateTone(entry.state)]}
                    >
                      <Td>
                        {entry.label}
                        <span className="ml-2 text-xs text-ink-3">
                          {subjectTypeLabel(entry.subject_type)}
                        </span>
                      </Td>
                      <Td>{formatTeam(entry.current_team)}</Td>
                      <Td>{formatTeam(entry.target_team)}</Td>
                      <Td>{proposalStateLabel(entry.state)}</Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <FieldRow label="Причина вето" className="w-48">
                <Select value={vetoReasonKind} onChange={(e) => setVetoReasonKind(e.target.value)}>
                  {VETO_REASON_KINDS.map((kind) => (
                    <option key={kind.value} value={kind.value}>
                      {kind.label}
                    </option>
                  ))}
                </Select>
              </FieldRow>
              <FieldRow label="Комментарий" hint="Обязателен для вето" className="w-72">
                <TextInput
                  type="text"
                  value={vetoReason}
                  onChange={(e) => setVetoReason(e.target.value)}
                />
              </FieldRow>
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button disabled={!canEdit} onClick={() => void decide('dismiss')}>
                Отклонить
              </Button>
              <Button disabled={!canEdit} onClick={() => void decide('veto')}>
                Вето
              </Button>
              <Button
                variant="primary"
                disabled={!canEdit}
                onClick={() => void decide('acknowledge')}
              >
                Принять к сведению
              </Button>
            </div>

            {detail.decisions.length > 0 ? (
              <ul className="space-y-1 text-xs text-ink-3">
                {detail.decisions.map((row) => (
                  <li key={row.id}>
                    {new Date(row.created_at).toLocaleString('ru-RU')} —{' '}
                    {decisionLabel(row.decision)}
                    {row.veto_reason ? ` — ${row.veto_reason}` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
          </CardBody>
        </Card>
      ) : null}
    </PageContainer>
  );
}

/** Служебный ярлык над значением — единственное место, где разрешён капслок (§1). */
function Signal({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-2xs uppercase tracking-[0.06em] text-ink-3">{label}</dt>
      <dd className="text-[13px] tabular-nums text-ink">{value}</dd>
    </div>
  );
}
