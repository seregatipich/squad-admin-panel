'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import {
  addLayer,
  buildSavePayload,
  filterPool,
  type LayerRow,
  moveEntry,
  type RotationEntry,
  removeAt,
  toRotationEntry,
} from './helpers';

interface Me {
  squad_permissions: string[];
}

interface RotationResponse {
  file_exists: boolean;
  has_managed_segment: boolean;
  entries: RotationEntry[];
  behavior: string;
  can_edit: boolean;
}

const GAMEMODE_OPTIONS = [
  'RAAS',
  'AAS',
  'Invasion',
  'TC',
  'Skirmish',
  'Destruction',
  'Insurgency',
  'Seed',
];

export default function RotationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [entries, setEntries] = useState<RotationEntry[]>([]);
  const [pool, setPool] = useState<LayerRow[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerMap, setPickerMap] = useState('');
  const [pickerGamemode, setPickerGamemode] = useState('');
  const [pickerSeedOnly, setPickerSeedOnly] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [meRes, rotationRes, layersRes] = await Promise.all([
        fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
        fetch(`/api/v1/servers/${id}/rotation`, { credentials: 'include', cache: 'no-store' }),
        fetch('/api/v1/layers', { credentials: 'include', cache: 'no-store' }),
      ]);
      if (!meRes.ok) throw new Error(`HTTP ${meRes.status}`);
      if (!rotationRes.ok) throw new Error(`HTTP ${rotationRes.status}`);
      if (!layersRes.ok) throw new Error(`HTTP ${layersRes.status}`);
      const me = (await meRes.json()) as Me;
      const rotation = (await rotationRes.json()) as RotationResponse;
      const layersBody = (await layersRes.json()) as { rows: LayerRow[] };
      setCanEdit(rotation.can_edit && me.squad_permissions.includes('changemap'));
      setEntries(rotation.entries);
      setPool(layersBody.rows);
      setDirty(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const mapOptions = useMemo(
    () => Array.from(new Set(pool.map((layer) => layer.map))).sort(),
    [pool],
  );

  const filteredPool = useMemo(
    () =>
      filterPool(pool, {
        map: pickerMap || undefined,
        gamemode: pickerGamemode || undefined,
        seedOnly: pickerSeedOnly,
        query: pickerQuery,
      }),
    [pool, pickerMap, pickerGamemode, pickerSeedOnly, pickerQuery],
  );

  function handleMove(from: number, to: number) {
    if (!canEdit) return;
    setEntries((prev) => moveEntry(prev, from, to));
    setDirty(true);
  }

  function handleDrop(targetIndex: number) {
    if (!canEdit || dragIndex === null) {
      setDragIndex(null);
      return;
    }
    handleMove(dragIndex, targetIndex);
    setDragIndex(null);
  }

  function handleAdd(layer: LayerRow) {
    if (!canEdit) return;
    setEntries((prev) => addLayer(prev, toRotationEntry(layer)));
    setDirty(true);
  }

  function handleRemove(index: number) {
    if (!canEdit) return;
    setEntries((prev) => removeAt(prev, index));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/servers/${id}/rotation`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildSavePayload(entries)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      setDirty(false);
      setMsg('Сохранено — применится со следующего матча');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  return (
    <div className="max-w-4xl space-y-4 pb-20">
      <header>
        <h1 className="text-xl font-semibold">Ротация</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Порядок слоёв в управляемом сегменте <span className="font-mono">LayerRotation.cfg</span>.
          Комментарии и ручные правки вне сегмента панель не трогает.
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

      <ul className="space-y-2" data-testid="rotation-list">
        {entries.length === 0 ? (
          <li className="rounded border border-neutral-800 bg-neutral-950 px-3 py-6 text-center text-sm text-neutral-500">
            Ротация пуста.
          </li>
        ) : null}
        {entries.map((entry, index) => (
          <li
            key={`${entry.layer}-${index}`}
            draggable={canEdit}
            onDragStart={() => canEdit && setDragIndex(index)}
            onDragOver={(e) => {
              if (canEdit && dragIndex !== null) e.preventDefault();
            }}
            onDrop={() => handleDrop(index)}
            className={`flex items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 ${
              dragIndex === index ? 'opacity-40' : ''
            }`}
          >
            <div className="flex items-center gap-3">
              <span className="w-6 text-right text-xs text-neutral-600">{index + 1}</span>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{entry.layer}</span>
                  {!entry.known ? (
                    <span className="rounded bg-amber-800 px-1 py-[1px] text-[10px] uppercase tracking-widest text-amber-100">
                      Нет в каталоге слоёв
                    </span>
                  ) : null}
                  {entry.is_seed ? (
                    <span className="rounded bg-sky-800 px-1 py-[1px] text-[10px] uppercase tracking-widest text-sky-100">
                      Seed
                    </span>
                  ) : null}
                </div>
                {entry.known ? (
                  <div className="text-xs text-neutral-500">
                    {entry.map} · {entry.gamemode}
                  </div>
                ) : null}
              </div>
            </div>
            {canEdit ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleMove(index, index - 1)}
                  disabled={index === 0}
                  aria-label="Переместить вверх"
                  className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => handleMove(index, index + 1)}
                  disabled={index === entries.length - 1}
                  aria-label="Переместить вниз"
                  className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => handleRemove(index)}
                  aria-label="Удалить"
                  className="rounded px-2 py-1 text-xs text-red-400 hover:bg-neutral-800"
                >
                  Удалить
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {canEdit ? (
        <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="rounded border border-sky-900 px-3 py-1.5 text-sm text-sky-300 hover:border-sky-700"
          >
            {pickerOpen ? 'Скрыть пул' : 'Добавить слой'}
          </button>
          {pickerOpen ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                <input
                  type="text"
                  value={pickerQuery}
                  onChange={(e) => setPickerQuery(e.target.value)}
                  placeholder="Поиск по имени"
                  className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
                />
                <select
                  value={pickerMap}
                  onChange={(e) => setPickerMap(e.target.value)}
                  className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
                >
                  <option value="">Любая карта</option>
                  {mapOptions.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <select
                  value={pickerGamemode}
                  onChange={(e) => setPickerGamemode(e.target.value)}
                  className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm"
                >
                  <option value="">Любой режим</option>
                  {GAMEMODE_OPTIONS.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-xs text-neutral-400">
                  <input
                    type="checkbox"
                    checked={pickerSeedOnly}
                    onChange={(e) => setPickerSeedOnly(e.target.checked)}
                  />
                  только seed
                </label>
              </div>
              <div className="max-h-64 overflow-y-auto rounded border border-neutral-900">
                {filteredPool.map((layer) => (
                  <div
                    key={layer.id}
                    className="flex items-center justify-between gap-2 border-b border-neutral-900 px-3 py-1.5 text-xs last:border-b-0"
                  >
                    <span className="font-mono">{layer.name}</span>
                    <button
                      type="button"
                      onClick={() => handleAdd(layer)}
                      className="rounded bg-sky-700 px-2 py-0.5 text-white hover:bg-sky-600"
                    >
                      Добавить
                    </button>
                  </div>
                ))}
                {filteredPool.length === 0 ? (
                  <div className="px-3 py-4 text-center text-neutral-500">Ничего не найдено.</div>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {canEdit ? (
        <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-950 px-4 py-3">
          <span className="rounded bg-sky-900/60 px-2 py-1 text-xs text-sky-200">
            Применится со следующего матча
          </span>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="rounded bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
