'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  type BalancerFilters,
  balancerViewState,
  buildProposalsQuery,
  DEFAULT_BALANCER_FILTERS,
  decisionLabel,
  formatTeam,
  proposalStateLabel,
  proposalStateRowClass,
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

const VIEW_STATE_NOTES: Record<string, string> = {
  loading: 'Загрузка…',
  empty:
    'Снимков от экспортёра ещё не поступало. Страница работает — как только SquadJS пришлёт первый снимок, он появится здесь.',
  healthy: 'Признаков дисбаланса нет: ни один сигнал не достиг порога.',
  imbalance: 'Есть снимки с превышением порогов — проверьте предложения ниже.',
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
 * deliberately left out of v1. Row colours come exclusively from
 * `proposalStateRowClass`, so what an operator sees is a pure function of the
 * payload's `state` enum.
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Балансировщик команд</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Предложения по балансу приходят из SquadJS в режиме dry-run. Панель показывает их для
          разбора и хранит решения операторов — принудительный перевод игроков отсюда не
          выполняется.
        </p>
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          Ошибка загрузки: {error}
        </div>
      ) : null}
      {failure ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {failure}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded border border-emerald-900 bg-emerald-950 p-3 text-sm text-emerald-200">
          {notice}
        </div>
      ) : null}

      <section className="space-y-3 rounded border border-neutral-800 p-4">
        <h2 className="text-lg font-medium">Правила</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {NUMBER_FIELDS.map((field) => (
            <label key={field.key} className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-300">
                {field.label} <span className="text-xs text-neutral-500">({field.hint})</span>
              </span>
              <input
                type="number"
                disabled={!canEdit}
                value={String(settings[field.key])}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    [field.key]: Number.parseInt(e.target.value, 10) || 0,
                  }))
                }
                className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm disabled:opacity-50"
              />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          {FLAG_FIELDS.map((field) => (
            <label key={field.key} className="flex items-center gap-2 text-neutral-300">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={Boolean(settings[field.key])}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, [field.key]: e.target.checked }))
                }
              />
              {field.label}
            </label>
          ))}
        </div>
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => void saveSettings()}
          className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500 disabled:opacity-50"
        >
          Сохранить правила
        </button>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <div className="inline-flex overflow-hidden rounded border border-neutral-800">
            <button
              type="button"
              onClick={() => setFilters((prev) => ({ ...prev, mode: 'squad' }))}
              className={
                filters.mode === 'squad'
                  ? 'bg-neutral-800 px-3 py-1.5'
                  : 'px-3 py-1.5 hover:bg-neutral-900'
              }
            >
              По отрядам
            </button>
            <button
              type="button"
              disabled={!settings.player_level_enabled}
              title={
                settings.player_level_enabled
                  ? undefined
                  : 'Режим по игрокам выключен в правилах выше'
              }
              onClick={() => setFilters((prev) => ({ ...prev, mode: 'player' }))}
              className={
                filters.mode === 'player'
                  ? 'bg-neutral-800 px-3 py-1.5 disabled:opacity-40'
                  : 'px-3 py-1.5 hover:bg-neutral-900 disabled:opacity-40'
              }
            >
              По игрокам
            </button>
          </div>
          <select
            value={filters.status}
            onChange={(e) => setFilters((prev) => ({ ...prev, status: e.target.value }))}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-neutral-500">Обновление каждые 8 с</span>
        </div>

        <p className="text-sm text-neutral-400">{VIEW_STATE_NOTES[viewState] ?? ''}</p>

        <div className="overflow-x-auto rounded border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-xs uppercase tracking-widest text-neutral-400">
              <tr>
                <th className="p-2 text-left">Снимок</th>
                <th className="p-2 text-left">Слой / режим</th>
                <th className="p-2 text-left">Сигналы</th>
                <th className="p-2 text-left">Диф</th>
                <th className="p-2 text-left">Статус</th>
                <th className="p-2 text-left" />
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-3 text-neutral-500">
                    Нет снимков по фильтру
                  </td>
                </tr>
              ) : null}
              {items.map((item) => {
                const counts = summarizeStates(item.proposal);
                return (
                  <tr key={item.id} className="border-t border-neutral-900">
                    <td className="p-2">
                      <div className="font-mono text-xs">{item.source_snapshot_id}</div>
                      <div className="text-xs text-neutral-500">
                        {new Date(item.generated_at).toLocaleString('ru-RU')}
                      </div>
                    </td>
                    <td className="p-2 text-neutral-300">
                      {item.layer ?? '—'}
                      <div className="text-xs text-neutral-500">{item.gamemode ?? '—'}</div>
                    </td>
                    <td className="p-2">
                      {item.evaluation.reasons.map((reason) => (
                        <div key={reason.kind} className="text-xs text-red-300">
                          {triggerReasonLabel(reason)}
                        </div>
                      ))}
                      {item.evaluation.triggered ? null : (
                        <span className="text-xs text-emerald-300">В норме</span>
                      )}
                    </td>
                    <td className="p-2 text-xs text-neutral-400">
                      <span className="text-red-300">{counts.should_move}</span> /{' '}
                      <span className="text-neutral-300">{counts.no_change}</span> /{' '}
                      <span className="text-emerald-300">{counts.on_target}</span>
                    </td>
                    <td className="p-2 text-neutral-300">{proposalStatusLabel(item.status)}</td>
                    <td className="p-2">
                      <button
                        type="button"
                        onClick={() => void openDetail(item.id)}
                        className="rounded border border-neutral-800 px-2 py-1 text-xs hover:border-neutral-600"
                      >
                        Разобрать
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {detail ? (
        <section className="space-y-3 rounded border border-neutral-800 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Снимок {detail.source_snapshot_id}</h2>
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="text-xs text-neutral-400 underline hover:text-neutral-200"
            >
              Закрыть
            </button>
          </div>

          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <div>
              Серия побед:{' '}
              <span className="text-neutral-300">{signalValue(detail.signals, 'win_streak')}</span>
            </div>
            <div>
              Разница тикетов:{' '}
              <span className="text-neutral-300">{signalValue(detail.signals, 'ticket_diff')}</span>
            </div>
            <div>
              Односторонних раундов:{' '}
              <span className="text-neutral-300">
                {signalValue(detail.signals, 'one_sided_rounds')}
              </span>
            </div>
          </div>

          <div className="overflow-x-auto rounded border border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900 text-xs uppercase tracking-widest text-neutral-400">
                <tr>
                  <th className="p-2 text-left">Субъект</th>
                  <th className="p-2 text-left">Сейчас</th>
                  <th className="p-2 text-left">Предлагается</th>
                  <th className="p-2 text-left">Состояние</th>
                </tr>
              </thead>
              <tbody>
                {detail.proposal.map((entry) => (
                  <tr
                    key={`${entry.subject_type}:${entry.subject_id}`}
                    className={proposalStateRowClass(entry.state)}
                  >
                    <td className="p-2">
                      {entry.label}
                      <span className="ml-2 text-xs text-neutral-500">
                        {subjectTypeLabel(entry.subject_type)}
                      </span>
                    </td>
                    <td className="p-2 text-neutral-300">{formatTeam(entry.current_team)}</td>
                    <td className="p-2 text-neutral-300">{formatTeam(entry.target_team)}</td>
                    <td className="p-2">{proposalStateLabel(entry.state)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-neutral-300">Причина вето</span>
              <select
                value={vetoReasonKind}
                onChange={(e) => setVetoReasonKind(e.target.value)}
                className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm"
              >
                {VETO_REASON_KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </select>
            </label>
            <input
              type="text"
              value={vetoReason}
              onChange={(e) => setVetoReason(e.target.value)}
              placeholder="Комментарий (обязателен для вето)"
              className="w-72 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm"
            />
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => void decide('acknowledge')}
              className="rounded border border-neutral-800 px-3 py-1.5 hover:border-neutral-600 disabled:opacity-50"
            >
              Принять к сведению
            </button>
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => void decide('veto')}
              className="rounded border border-red-900 px-3 py-1.5 text-red-200 hover:border-red-700 disabled:opacity-50"
            >
              Вето
            </button>
            <button
              type="button"
              disabled={!canEdit}
              onClick={() => void decide('dismiss')}
              className="rounded border border-neutral-800 px-3 py-1.5 hover:border-neutral-600 disabled:opacity-50"
            >
              Отклонить
            </button>
          </div>

          <div className="space-y-1 text-xs text-neutral-400">
            {detail.decisions.map((row) => (
              <div key={row.id}>
                {new Date(row.created_at).toLocaleString('ru-RU')} — {decisionLabel(row.decision)}
                {row.veto_reason ? ` — ${row.veto_reason}` : ''}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
