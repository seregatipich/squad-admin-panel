'use client';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { canSubmitLayer, filterLayers, formatMatchElapsed } from './map-widget-helpers';

const REFRESH_INTERVAL_MS = 10_000;

interface MapSide {
  layer: string;
  map: string | null;
  gamemode: string | null;
  deprecated: boolean;
}

interface MapResponse {
  current: MapSide | null;
  next: MapSide | null;
  match_started_at: string | null;
}

interface CatalogLayer {
  id: string;
  name: string;
  map: string;
  gamemode: string;
  deprecated: boolean;
}

type PickerMode = 'next' | 'change' | null;

async function readJsonError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * ROT-3 (#146): current/next-map widget for the server detail page. Shows
 * the current layer (map/gamemode/elapsed match time) and the next layer —
 * "По ротации" when Squad hasn't got one queued (`ShowNextMap` → "to be
 * voted"). When `canChangeMap` (the `changemap` squad permission) is set,
 * renders three gated actions: queue a next layer, change the layer now
 * (with a reset warning), and end the current match — each backed by
 * `POST /api/v1/servers/:serverId/map/{next,change,end-match}`.
 */
export function MapWidget({ serverId, canChangeMap }: { serverId: string; canChangeMap: boolean }) {
  const [data, setData] = useState<MapResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [catalog, setCatalog] = useState<CatalogLayer[]>([]);
  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerSelected, setPickerSelected] = useState<CatalogLayer | null>(null);
  const [confirmDeprecated, setConfirmDeprecated] = useState(false);
  const [endMatchConfirmOpen, setEndMatchConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const searchInputId = useId();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/servers/${serverId}/map`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as MapResponse);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!canChangeMap) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/v1/layers', { credentials: 'include', cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { rows: CatalogLayer[] };
        if (!cancelled) setCatalog(body.rows);
      } catch {
        // catalog fetch is best-effort — the picker just stays empty
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canChangeMap]);

  const onMapChanged = useCallback(
    (event: { data: { server_id: string } }) => {
      if (event.data.server_id === serverId) void load();
    },
    [serverId, load],
  );
  useLiveSubscription('server.map.changed', onMapChanged);
  useLiveSubscription('match.started', onMapChanged);
  useLiveSubscription('match.ended', onMapChanged);
  useLiveSubscription('rcon.status', onMapChanged);

  const filteredCatalog = useMemo(() => filterLayers(catalog, pickerQuery), [catalog, pickerQuery]);

  function openPicker(mode: 'next' | 'change') {
    setPickerMode(mode);
    setPickerQuery('');
    setPickerSelected(null);
    setConfirmDeprecated(false);
    setFeedback(null);
  }

  function closePicker() {
    setPickerMode(null);
    setPickerSelected(null);
    setConfirmDeprecated(false);
  }

  async function submitPicker() {
    if (!pickerMode || !pickerSelected || busy) return;
    if (pickerMode === 'change' && !confirm('Матч будет сброшен. Сменить карту сейчас?')) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/v1/servers/${serverId}/map/${pickerMode}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          layer: pickerSelected.name,
          confirm_deprecated: confirmDeprecated,
        }),
      });
      if (!res.ok) throw new Error(await readJsonError(res));
      setFeedback({
        kind: 'ok',
        text: pickerMode === 'next' ? 'Следующая карта установлена' : 'Карта сменена',
      });
      closePicker();
      void load();
    } catch (e) {
      setFeedback({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function submitEndMatch() {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/v1/servers/${serverId}/map/end-match`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await readJsonError(res));
      setFeedback({ kind: 'ok', text: 'Матч завершён' });
      setEndMatchConfirmOpen(false);
      void load();
    } catch (e) {
      setFeedback({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = canSubmitLayer(pickerSelected, confirmDeprecated);

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4">
      <h2 className="mb-3 text-xs uppercase tracking-widest text-neutral-400">Карта</h2>

      {err ? <p className="mb-3 text-xs text-red-400">Ошибка загрузки: {err}</p> : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded border border-neutral-800 bg-neutral-900 p-3">
          <div className="mb-1 text-xs text-neutral-500">Текущая карта</div>
          {data?.current ? (
            <>
              <div className="text-sm text-neutral-100">{data.current.layer}</div>
              <div className="mt-1 text-xs text-neutral-400">
                {data.current.map ?? '—'}
                {data.current.gamemode ? ` · ${data.current.gamemode}` : ''}
              </div>
              <div className="mt-1 text-xs text-sky-400">
                идёт {formatMatchElapsed(data.match_started_at, now)}
              </div>
            </>
          ) : (
            <div className="text-sm text-neutral-500">—</div>
          )}
        </div>

        <div className="rounded border border-neutral-800 bg-neutral-900 p-3">
          <div className="mb-1 text-xs text-neutral-500">Следующая карта</div>
          {data?.next ? (
            <>
              <div className="text-sm text-neutral-100">{data.next.layer}</div>
              <div className="mt-1 text-xs text-neutral-400">
                {data.next.map ?? '—'}
                {data.next.gamemode ? ` · ${data.next.gamemode}` : ''}
                {data.next.deprecated ? (
                  <span className="ml-2 text-amber-400">устаревший</span>
                ) : null}
              </div>
            </>
          ) : (
            <div className="text-sm text-neutral-500">По ротации</div>
          )}
        </div>
      </div>

      {canChangeMap ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => openPicker('next')}
            className="rounded border border-sky-900 px-3 py-1.5 text-xs text-sky-300 hover:border-sky-700"
          >
            Следующая
          </button>
          <button
            type="button"
            onClick={() => openPicker('change')}
            className="rounded border border-amber-900 px-3 py-1.5 text-xs text-amber-300 hover:border-amber-700"
          >
            Сменить сейчас
          </button>
          <button
            type="button"
            onClick={() => setEndMatchConfirmOpen(true)}
            className="rounded border border-red-900 px-3 py-1.5 text-xs text-red-300 hover:border-red-700"
          >
            Завершить матч
          </button>
        </div>
      ) : null}

      {feedback ? (
        <p
          className={`mt-2 text-xs ${feedback.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}
        >
          {feedback.text}
        </p>
      ) : null}

      {pickerMode ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
          <div className="mt-16 w-full max-w-lg rounded border border-neutral-800 bg-neutral-950 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">
                {pickerMode === 'next' ? 'Установить следующую карту' : 'Сменить карту сейчас'}
              </h3>
              <button
                type="button"
                onClick={closePicker}
                className="text-sm text-neutral-400 hover:text-neutral-200"
              >
                Закрыть
              </button>
            </div>

            {pickerMode === 'change' ? (
              <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                Внимание: текущий матч будет сброшен немедленно.
              </p>
            ) : null}

            <div>
              <label htmlFor={searchInputId} className="mb-1 block text-xs text-neutral-500">
                Поиск слоя
              </label>
              <input
                id={searchInputId}
                type="text"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder="напр. Yehorivka"
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              />
            </div>

            <div className="max-h-64 space-y-1 overflow-y-auto">
              {filteredCatalog.length === 0 ? (
                <p className="text-xs text-neutral-500">Ничего не найдено.</p>
              ) : (
                filteredCatalog.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => {
                      setPickerSelected(row);
                      setConfirmDeprecated(false);
                    }}
                    className={`flex w-full items-center justify-between rounded border px-3 py-2 text-left text-sm ${
                      pickerSelected?.id === row.id
                        ? 'border-sky-600 bg-sky-950/40 text-sky-200'
                        : 'border-neutral-800 bg-neutral-900 text-neutral-200 hover:border-neutral-600'
                    }`}
                  >
                    <span>
                      {row.name}
                      <span className="ml-2 text-xs text-neutral-500">
                        {row.map} · {row.gamemode}
                      </span>
                    </span>
                    {row.deprecated ? (
                      <span className="text-xs text-amber-400">устаревший</span>
                    ) : null}
                  </button>
                ))
              )}
            </div>

            {pickerSelected?.deprecated ? (
              <label className="flex items-center gap-2 text-xs text-amber-300">
                <input
                  type="checkbox"
                  checked={confirmDeprecated}
                  onChange={(e) => setConfirmDeprecated(e.target.checked)}
                />
                Понимаю, слой устаревший
              </label>
            ) : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closePicker}
                className="rounded border border-neutral-800 px-4 py-1.5 text-sm text-neutral-300 hover:border-neutral-600"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => void submitPicker()}
                disabled={!canSubmit || busy}
                className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
              >
                {busy ? 'Отправка…' : 'Применить'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {endMatchConfirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
          <div className="mt-16 w-full max-w-sm rounded border border-neutral-800 bg-neutral-950 p-5 space-y-4">
            <h3 className="text-lg font-semibold">Завершить матч?</h3>
            <p className="text-xs text-neutral-400">
              Текущий матч на сервере будет немедленно завершён (AdminEndMatch).
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEndMatchConfirmOpen(false)}
                className="rounded border border-neutral-800 px-4 py-1.5 text-sm text-neutral-300 hover:border-neutral-600"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => void submitEndMatch()}
                disabled={busy}
                className="rounded border border-red-900 px-4 py-1.5 text-sm text-red-300 hover:border-red-700 disabled:opacity-40"
              >
                {busy ? 'Отправка…' : 'Завершить'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
