'use client';

import { use, useCallback, useEffect, useState } from 'react';
import {
  addCandidate,
  buildCandidatesPayload,
  buildSettingsPayload,
  type MapVoteCandidate,
  type MapVoteSettingsForm,
  removeCandidateAt,
  validateCandidates,
  validateSettings,
} from './helpers';

interface Me {
  squad_permissions: string[];
}

interface MapVoteResponse {
  enabled: boolean;
  selection: 'weighted_random' | 'least_recently_played';
  layer_cooldown: number;
  map_cooldown: number;
  broadcast_template: string | null;
  can_edit: boolean;
  candidates: MapVoteCandidate[];
}

interface PreviewResponse {
  eligible: Array<{ layer: string; weight: number; probability: number }>;
  excluded: Array<{ layer: string; reason: string }>;
  would_pick: string | null;
}

interface PickRow {
  id: string;
  match_id: string;
  layer: string;
  selection: string;
  applied: boolean;
  failure_reason: string | null;
  created_at: string;
}

interface CatalogLayer {
  id: string;
  name: string;
  map: string;
  gamemode: string;
  deprecated: boolean;
}

const EXCLUSION_LABELS: Record<string, string> = {
  disabled: 'выключен',
  deprecated: 'устаревший слой',
  layer_cooldown: 'кулдаун слоя',
  map_cooldown: 'кулдаун карты',
};

export default function MapVotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [form, setForm] = useState<MapVoteSettingsForm>({
    enabled: false,
    selection: 'weighted_random',
    layerCooldown: 3,
    mapCooldown: 2,
    broadcastTemplate: '',
  });
  const [candidates, setCandidates] = useState<MapVoteCandidate[]>([]);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [picks, setPicks] = useState<PickRow[]>([]);
  const [pool, setPool] = useState<CatalogLayer[]>([]);
  const [selectedLayer, setSelectedLayer] = useState('');
  const [confirmDeprecated, setConfirmDeprecated] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [meRes, stateRes, previewRes, picksRes, layersRes] = await Promise.all([
        fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
        fetch(`/api/v1/servers/${id}/map-vote`, { credentials: 'include', cache: 'no-store' }),
        fetch(`/api/v1/servers/${id}/map-vote/preview`, {
          credentials: 'include',
          cache: 'no-store',
        }),
        fetch(`/api/v1/servers/${id}/map-vote/picks?limit=20`, {
          credentials: 'include',
          cache: 'no-store',
        }),
        fetch('/api/v1/layers', { credentials: 'include', cache: 'no-store' }),
      ]);
      for (const res of [meRes, stateRes, previewRes, picksRes, layersRes]) {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      const me = (await meRes.json()) as Me;
      const state = (await stateRes.json()) as MapVoteResponse;
      const previewBody = (await previewRes.json()) as PreviewResponse;
      const picksBody = (await picksRes.json()) as { picks: PickRow[] };
      const layersBody = (await layersRes.json()) as { rows: CatalogLayer[] };

      setForm({
        enabled: state.enabled,
        selection: state.selection,
        layerCooldown: state.layer_cooldown,
        mapCooldown: state.map_cooldown,
        broadcastTemplate: state.broadcast_template ?? '',
      });
      setCandidates(state.candidates);
      setPreview(previewBody);
      setPicks(picksBody.picks);
      setPool(layersBody.rows);
      setCanEdit(state.can_edit && me.squad_permissions.includes('changemap'));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSettings() {
    const validation = validateSettings(form, candidates.length);
    if (validation) {
      setErr(validation);
      return;
    }
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/map-vote/settings`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildSettingsPayload(form)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      setMsg('Настройки сохранены');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function saveCandidates() {
    const validation = validateCandidates(candidates);
    if (validation) {
      setErr(validation);
      return;
    }
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/map-vote/candidates`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildCandidatesPayload(candidates, confirmDeprecated)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      setMsg('Кандидаты сохранены');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function handleAddCandidate() {
    const layer = pool.find((row) => row.name === selectedLayer);
    if (!layer) return;
    setCandidates((prev) => addCandidate(prev, layer));
    setSelectedLayer('');
  }

  function updateCandidate(index: number, patch: Partial<MapVoteCandidate>) {
    setCandidates((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  if (loading) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  return (
    <div className="max-w-4xl space-y-4 pb-20">
      <header>
        <h1 className="text-xl font-semibold">Голосование за карту</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Автовыбор следующего слоя: панель выбирает из пула кандидатов и отправляет{' '}
          <span className="font-mono">AdminSetNextLayer</span> раз в матч.
        </p>
      </header>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm">{err}</div>
      ) : null}
      {msg ? (
        <div className="rounded border border-emerald-900 bg-emerald-950 px-3 py-2 text-sm text-emerald-200">
          {msg}
        </div>
      ) : null}

      {!canEdit ? (
        <div className="rounded border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-400">
          Только просмотр — нужна squad-привилегия changemap.
        </div>
      ) : null}

      <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-sm font-semibold text-neutral-300">Настройки</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={!canEdit}
            onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
          />
          Автовыбор включён
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-xs text-neutral-400">
            Правило выбора
            <select
              value={form.selection}
              disabled={!canEdit}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  selection: e.target.value as MapVoteSettingsForm['selection'],
                }))
              }
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200"
            >
              <option value="weighted_random">Взвешенный случайный</option>
              <option value="least_recently_played">Давно не игравшийся</option>
            </select>
          </label>
          <label className="space-y-1 text-xs text-neutral-400">
            Кулдаун слоя (матчей)
            <input
              type="number"
              value={form.layerCooldown}
              disabled={!canEdit}
              onChange={(e) => setForm((f) => ({ ...f, layerCooldown: Number(e.target.value) }))}
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200"
            />
          </label>
          <label className="space-y-1 text-xs text-neutral-400">
            Кулдаун карты (матчей)
            <input
              type="number"
              value={form.mapCooldown}
              disabled={!canEdit}
              onChange={(e) => setForm((f) => ({ ...f, mapCooldown: Number(e.target.value) }))}
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200"
            />
          </label>
        </div>
        <label className="block space-y-1 text-xs text-neutral-400">
          Шаблон объявления (необязательно)
          <input
            type="text"
            value={form.broadcastTemplate}
            disabled={!canEdit}
            placeholder="Следующая карта: {layer}"
            onChange={(e) => setForm((f) => ({ ...f, broadcastTemplate: e.target.value }))}
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200"
          />
        </label>
        {canEdit ? (
          <button
            type="button"
            onClick={saveSettings}
            disabled={saving}
            className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? 'Сохраняю…' : 'Сохранить настройки'}
          </button>
        ) : null}
      </section>

      <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-sm font-semibold text-neutral-300">Кандидаты</h2>
        <ul className="space-y-2" data-testid="candidates-list">
          {candidates.length === 0 ? (
            <li className="rounded border border-neutral-800 bg-neutral-950 px-3 py-4 text-center text-sm text-neutral-500">
              Пул кандидатов пуст.
            </li>
          ) : null}
          {candidates.map((candidate, index) => (
            <li
              key={candidate.layer}
              className="flex items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-950 px-3 py-2"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{candidate.layer}</span>
                  {candidate.deprecated ? (
                    <span className="rounded bg-amber-800 px-1 py-[1px] text-[10px] uppercase tracking-widest text-amber-100">
                      Устаревший
                    </span>
                  ) : null}
                </div>
                {candidate.map ? (
                  <div className="text-xs text-neutral-500">
                    {candidate.map} · {candidate.gamemode}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1 text-xs text-neutral-400">
                  Вес
                  <input
                    type="number"
                    value={candidate.weight}
                    disabled={!canEdit}
                    aria-label={`Вес ${candidate.layer}`}
                    onChange={(e) => updateCandidate(index, { weight: Number(e.target.value) })}
                    className="w-16 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200"
                  />
                </label>
                <label className="flex items-center gap-1 text-xs text-neutral-400">
                  <input
                    type="checkbox"
                    checked={candidate.enabled}
                    disabled={!canEdit}
                    onChange={(e) => updateCandidate(index, { enabled: e.target.checked })}
                  />
                  вкл
                </label>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => setCandidates((prev) => removeCandidateAt(prev, index))}
                    className="rounded px-2 py-1 text-xs text-red-400 hover:bg-neutral-800"
                  >
                    Удалить
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {canEdit ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <select
                value={selectedLayer}
                onChange={(e) => setSelectedLayer(e.target.value)}
                aria-label="Слой из каталога"
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200"
              >
                <option value="">Выберите слой…</option>
                {pool.map((layer) => (
                  <option key={layer.id} value={layer.name}>
                    {layer.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleAddCandidate}
                disabled={selectedLayer === ''}
                className="rounded border border-sky-900 px-3 py-1.5 text-sm text-sky-300 hover:border-sky-700 disabled:opacity-40"
              >
                Добавить слой
              </button>
            </div>
            <label className="flex items-center gap-2 text-xs text-neutral-400">
              <input
                type="checkbox"
                checked={confirmDeprecated}
                onChange={(e) => setConfirmDeprecated(e.target.checked)}
              />
              подтвердить устаревшие слои
            </label>
            <button
              type="button"
              onClick={saveCandidates}
              disabled={saving}
              className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? 'Сохраняю…' : 'Сохранить кандидатов'}
            </button>
          </div>
        ) : null}
      </section>

      <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-sm font-semibold text-neutral-300">Предпросмотр выбора</h2>
        {preview ? (
          <div className="space-y-2 text-sm">
            <div>
              Будет выбран:{' '}
              {preview.would_pick ? (
                <span className="font-mono text-emerald-300">{preview.would_pick}</span>
              ) : (
                <span className="text-neutral-500">нет подходящих кандидатов</span>
              )}
            </div>
            {preview.eligible.length > 0 ? (
              <ul className="space-y-1 text-xs text-neutral-400" data-testid="preview-eligible">
                {preview.eligible.map((row) => (
                  <li key={row.layer}>
                    <span className="font-mono">{row.layer}</span> — вес {row.weight},{' '}
                    {Math.round(row.probability * 100)}%
                  </li>
                ))}
              </ul>
            ) : null}
            {preview.excluded.length > 0 ? (
              <ul className="space-y-1 text-xs text-neutral-600" data-testid="preview-excluded">
                {preview.excluded.map((row) => (
                  <li key={row.layer}>
                    <span className="font-mono">{row.layer}</span> — исключён (
                    {EXCLUSION_LABELS[row.reason] ?? row.reason})
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <div className="text-sm text-neutral-500">Нет данных.</div>
        )}
      </section>

      <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-sm font-semibold text-neutral-300">История выборов</h2>
        {picks.length === 0 ? (
          <div className="text-sm text-neutral-500">Выборов ещё не было.</div>
        ) : (
          <ul className="space-y-1 text-xs" data-testid="picks-list">
            {picks.map((pick) => (
              <li key={pick.id} className="flex items-center gap-2 text-neutral-400">
                <span className="font-mono text-neutral-200">{pick.layer}</span>
                <span>{new Date(pick.created_at).toLocaleString('ru-RU')}</span>
                {pick.applied ? (
                  <span className="rounded bg-emerald-900/60 px-1 py-[1px] text-[10px] uppercase tracking-widest text-emerald-200">
                    Применён
                  </span>
                ) : (
                  <span className="rounded bg-amber-900/60 px-1 py-[1px] text-[10px] uppercase tracking-widest text-amber-200">
                    {pick.failure_reason ?? 'не применён'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
