'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ChevronDownIcon,
  ChevronUpIcon,
  EmptyState,
  IconButton,
  InlineBanner,
  PageContainer,
  SearchField,
  Select,
  Skeleton,
  Toolbar,
} from '@/components/ui';
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

  const poolFiltered =
    pickerQuery !== '' || pickerMap !== '' || pickerGamemode !== '' || pickerSeedOnly;

  function resetPoolFilters() {
    setPickerQuery('');
    setPickerMap('');
    setPickerGamemode('');
    setPickerSeedOnly(false);
  }

  /* Сброс приходит парой «обработчик + подпись» или не приходит вовсе:
     кнопка сброса без подписи была бы безымянной. */
  const resetProps = poolFiltered
    ? { onReset: resetPoolFilters, resetLabel: 'Сбросить фильтр' }
    : {};

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
    return (
      <PageContainer width="wide">
        <Skeleton variant="row" count={8} label="Ротация загружается" />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="wide">
      <p className="text-xs text-ink-3">
        Порядок слоёв в управляемом сегменте <span className="font-mono">LayerRotation.cfg</span>.
        Комментарии и ручные правки вне сегмента панель не трогает.
      </p>

      {err ? (
        <InlineBanner
          tone="crit"
          title={err}
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      ) : null}
      {msg ? <InlineBanner tone="good" title={msg} /> : null}

      {!canEdit ? (
        <InlineBanner tone="info" title="Только просмотр — нужна squad-привилегия changemap." />
      ) : null}

      {/* Перетаскивание строк остаётся нативным HTML5 drag-and-drop: примитива
          для переупорядочиваемого списка в дизайн-системе нет, а порядок здесь
          и есть содержимое страницы. Кнопки «вверх»/«вниз» дублируют его для
          клавиатуры. */}
      <ul className="space-y-2" data-testid="rotation-list">
        {entries.length === 0 ? (
          <li>
            <Card padding="none">
              <EmptyState
                title="Ротация пуста"
                description="Добавьте слои из каталога — порядок в списке станет порядком матчей."
              />
            </Card>
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
            className={`flex items-center justify-between gap-3 rounded-card border border-line bg-surface px-3 py-2 ${
              dragIndex === index ? 'opacity-40' : ''
            }`}
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="w-6 shrink-0 text-right text-2xs tabular-nums text-ink-3">
                {index + 1}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] text-ink">{entry.layer}</span>
                  {!entry.known ? <Badge tone="warn">Нет в каталоге слоёв</Badge> : null}
                  {entry.is_seed ? <Badge tone="accent">Seed</Badge> : null}
                </div>
                {entry.known ? (
                  <div className="text-xs text-ink-3">
                    {entry.map} · {entry.gamemode}
                  </div>
                ) : null}
              </div>
            </div>
            {canEdit ? (
              <div className="flex shrink-0 items-center gap-1">
                <IconButton
                  icon={<ChevronUpIcon />}
                  label="Переместить вверх"
                  onClick={() => handleMove(index, index - 1)}
                  disabled={index === 0}
                />
                <IconButton
                  icon={<ChevronDownIcon />}
                  label="Переместить вниз"
                  onClick={() => handleMove(index, index + 1)}
                  disabled={index === entries.length - 1}
                />
                <Button variant="ghost" size="sm" onClick={() => handleRemove(index)}>
                  Удалить
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {canEdit ? (
        <Card padding="none">
          <CardHeader
            title="Каталог слоёв"
            description="Слой добавляется в конец ротации; порядок правится стрелками или перетаскиванием."
            actions={
              <Button size="sm" onClick={() => setPickerOpen((v) => !v)}>
                {pickerOpen ? 'Скрыть пул' : 'Добавить слой'}
              </Button>
            }
          />
          {pickerOpen ? (
            <CardBody className="space-y-3">
              <Toolbar
                search={
                  <SearchField
                    value={pickerQuery}
                    onCommit={setPickerQuery}
                    placeholder="Поиск по имени"
                    label="Поиск по имени слоя"
                    clearLabel="Очистить поиск"
                  />
                }
                filters={
                  <>
                    <Select
                      value={pickerMap}
                      aria-label="Карта"
                      onChange={(e) => setPickerMap(e.target.value)}
                    >
                      <option value="">Любая карта</option>
                      {mapOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </Select>
                    <Select
                      value={pickerGamemode}
                      aria-label="Режим"
                      onChange={(e) => setPickerGamemode(e.target.value)}
                    >
                      <option value="">Любой режим</option>
                      {GAMEMODE_OPTIONS.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </Select>
                    <Checkbox
                      label="Только seed"
                      checked={pickerSeedOnly}
                      onChange={(e) => setPickerSeedOnly(e.target.checked)}
                    />
                  </>
                }
                summary={`Найдено ${filteredPool.length}`}
                {...resetProps}
              />
              {filteredPool.length === 0 ? (
                <EmptyState
                  variant={poolFiltered ? 'filtered' : 'initial'}
                  title={poolFiltered ? 'Ничего не нашлось' : 'Каталог слоёв пуст'}
                  description={
                    poolFiltered
                      ? 'Ни один слой каталога не подходит под текущий фильтр.'
                      : 'В каталоге ROT-1 пока нет ни одного слоя.'
                  }
                  action={
                    poolFiltered ? (
                      <Button size="sm" onClick={resetPoolFilters}>
                        Сбросить фильтр
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-ctl border border-line">
                  {filteredPool.map((layer) => (
                    <li
                      key={layer.id}
                      className="flex items-center justify-between gap-2 px-3 py-1.5"
                    >
                      <span className="truncate font-mono text-xs text-ink">{layer.name}</span>
                      <Button size="sm" onClick={() => handleAdd(layer)}>
                        Добавить
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          ) : null}
        </Card>
      ) : null}

      {canEdit ? (
        <div className="sticky bottom-0 flex items-center justify-between gap-3 rounded-card border border-line bg-surface/80 px-4 py-3 backdrop-blur-xl">
          <Badge tone="accent">Применится со следующего матча</Badge>
          <Button variant="primary" onClick={save} disabled={!dirty} loading={saving}>
            Сохранить
          </Button>
        </div>
      ) : null}
    </PageContainer>
  );
}
