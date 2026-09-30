'use client';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  InlineBanner,
  Modal,
  SearchField,
} from '@/components/ui';
import { announcesMatchBoundary } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { canSubmitLayer, filterLayers, formatMatchElapsed } from './map-widget-helpers';

/** Резервный опрос: изменения карты приходят по live-шине, воркер обновляет статус раз в ~30 с. */
const REFRESH_INTERVAL_MS = 30_000;
/** Метка «идёт N мин» точна до минуты, чаще перерисовывать виджет незачем. */
const ELAPSED_TICK_MS = 30_000;

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

/** Служебный ярлык над значением — единственное место, где разрешён капслок (§1). */
function MapSlot({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-ctl border border-line bg-raised p-3">
      <p className="text-2xs uppercase tracking-[0.06em] text-ink-3">{label}</p>
      {children}
    </div>
  );
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
  const [changeConfirmOpen, setChangeConfirmOpen] = useState(false);
  const [endMatchConfirmOpen, setEndMatchConfirmOpen] = useState(false);
  const catalogRequested = useRef(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  /** Номер последнего запроса: запоздавший ответ не должен затирать более свежий. */
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const request = ++latestLoad.current;
    try {
      const res = await fetch(`/api/v1/servers/${serverId}/map`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as MapResponse;
      if (request !== latestLoad.current) return;
      setData(next);
      setErr(null);
    } catch (e) {
      if (request !== latestLoad.current) return;
      setErr((e as Error).message);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    // Каталог слоёв большой: грузим его при первом открытии окна выбора.
    if (!canChangeMap || pickerMode === null || catalogRequested.current) return;
    catalogRequested.current = true;
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
  }, [canChangeMap, pickerMode]);

  const onMapChanged = useCallback(
    (event: { data: { server_id: string } }) => {
      if (event.data.server_id === serverId) void load();
    },
    [serverId, load],
  );
  useLiveSubscription('server.map.changed', onMapChanged);
  useLiveSubscription('rcon.status', onMapChanged);
  /*
   * There is no `match.started`/`match.ended` live-bus event: nothing
   * publishes it, so subscribing to it here was a dead listener
   * (MATCHES-1296). A match starting or ending does reach the browser as a
   * `server.events.appended` batch.
   */
  const onEventsAppended = useCallback(
    (event: { data: { server_id: string | null; kinds: string[] } }) => {
      if (announcesMatchBoundary(event.data, serverId)) void load();
    },
    [serverId, load],
  );
  useLiveSubscription('server.events.appended', onEventsAppended);

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
      setChangeConfirmOpen(false);
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

  const dialogError =
    feedback?.kind === 'err' ? (
      <InlineBanner tone="crit" title="Не удалось выполнить действие" description={feedback.text} />
    ) : null;

  const canSubmit = canSubmitLayer(pickerSelected, confirmDeprecated);

  return (
    <Card padding="none" as="section">
      <CardHeader
        title="Карта"
        actions={
          canChangeMap ? (
            <>
              <Button size="sm" onClick={() => openPicker('next')}>
                Следующая
              </Button>
              <Button size="sm" onClick={() => openPicker('change')}>
                Сменить сейчас
              </Button>
              <Button size="sm" onClick={() => setEndMatchConfirmOpen(true)}>
                Завершить матч
              </Button>
            </>
          ) : undefined
        }
      />

      <CardBody className="space-y-3">
        {err ? (
          <InlineBanner
            tone="crit"
            title="Не удалось загрузить карту"
            description={err}
            action={
              <Button size="sm" onClick={() => void load()}>
                Повторить
              </Button>
            }
          />
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <MapSlot label="Текущая карта">
            {data?.current ? (
              <>
                <p className="mt-1 text-[17px] font-semibold text-ink">{data.current.layer}</p>
                <p className="mt-1 text-xs text-ink-3">
                  {data.current.map ?? '—'}
                  {data.current.gamemode ? ` · ${data.current.gamemode}` : ''}
                </p>
                <p className="mt-1 text-xs text-ink-2">
                  идёт {formatMatchElapsed(data.match_started_at, now)}
                </p>
              </>
            ) : (
              <p className="mt-1 text-[17px] font-semibold text-ink-3">—</p>
            )}
          </MapSlot>

          <MapSlot label="Следующая карта">
            {data?.next ? (
              <>
                <p className="mt-1 text-[17px] font-semibold text-ink">{data.next.layer}</p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                  <span>
                    {data.next.map ?? '—'}
                    {data.next.gamemode ? ` · ${data.next.gamemode}` : ''}
                  </span>
                  {data.next.deprecated ? (
                    <Badge tone="warn" size="sm">
                      устаревший
                    </Badge>
                  ) : null}
                </p>
              </>
            ) : (
              <p className="mt-1 text-[17px] font-semibold text-ink-3">По ротации</p>
            )}
          </MapSlot>
        </div>

        {feedback ? (
          <InlineBanner
            tone={feedback.kind === 'ok' ? 'good' : 'crit'}
            title={feedback.text}
            onDismiss={() => setFeedback(null)}
            dismissLabel="Скрыть сообщение"
          />
        ) : null}
      </CardBody>

      <Modal
        open={pickerMode !== null}
        onClose={closePicker}
        title={pickerMode === 'change' ? 'Сменить карту сейчас' : 'Установить следующую карту'}
        closeLabel="Отмена"
        size="md"
        footer={
          <>
            <Button onClick={closePicker}>Отмена</Button>
            <Button
              variant="primary"
              disabled={!canSubmit}
              loading={busy}
              onClick={() => {
                // Смена на ходу сбрасывает матч, поэтому она проходит через
                // отдельный вопрос; постановка следующей карты — нет.
                if (pickerMode === 'change') setChangeConfirmOpen(true);
                else void submitPicker();
              }}
            >
              Применить
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {dialogError}
          {pickerMode === 'change' ? (
            <InlineBanner
              tone="warn"
              title="Текущий матч будет сброшен немедленно"
              description="Игроки увидят загрузку новой карты сразу после подтверждения."
            />
          ) : null}

          <SearchField
            value={pickerQuery}
            // Фильтр идёт по уже загруженному каталогу, запроса за ним нет —
            // ждать паузы в наборе незачем.
            delay={0}
            onCommit={setPickerQuery}
            label="Поиск слоя"
            placeholder="напр. Yehorivka"
            clearLabel="Очистить поиск"
          />

          <div className="max-h-64 space-y-1 overflow-y-auto">
            {filteredCatalog.length === 0 ? (
              <EmptyState
                variant="filtered"
                title="Ничего не найдено"
                description="Ни один слой каталога не совпал с запросом."
                action={
                  <Button size="sm" onClick={() => setPickerQuery('')}>
                    Сбросить поиск
                  </Button>
                }
              />
            ) : (
              filteredCatalog.map((row) => {
                const selected = pickerSelected?.id === row.id;
                return (
                  <button
                    key={row.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setPickerSelected(row);
                      setConfirmDeprecated(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-ctl border px-3 py-2 text-left text-[13px] transition-colors duration-150 ${
                      selected
                        ? 'border-accent bg-accent-dim text-ink'
                        : 'border-line bg-raised text-ink-2 hover:text-ink'
                    }`}
                  >
                    <span>
                      {row.name}
                      <span className="ml-2 text-xs text-ink-3">
                        {row.map} · {row.gamemode}
                      </span>
                    </span>
                    {row.deprecated ? (
                      <Badge tone="warn" size="sm">
                        устаревший
                      </Badge>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>

          {pickerSelected?.deprecated ? (
            <Checkbox
              checked={confirmDeprecated}
              onChange={(event) => setConfirmDeprecated(event.target.checked)}
              label="Понимаю, слой устаревший"
            />
          ) : null}
        </div>
      </Modal>

      <AlertDialog
        open={changeConfirmOpen}
        onClose={() => setChangeConfirmOpen(false)}
        title="Сменить карту сейчас?"
        body={
          <>
            <p>{`Матч будет сброшен, и сервер загрузит «${pickerSelected?.name ?? ''}».`}</p>
            {dialogError}
          </>
        }
        confirmLabel="Сменить карту"
        cancelLabel="Отмена"
        tone="default"
        busy={busy}
        onConfirm={submitPicker}
      />

      <AlertDialog
        open={endMatchConfirmOpen}
        onClose={() => setEndMatchConfirmOpen(false)}
        title="Завершить матч?"
        body={
          <>
            <p>Текущий матч на сервере будет немедленно завершён (AdminEndMatch).</p>
            {dialogError}
          </>
        }
        confirmLabel="Завершить"
        cancelLabel="Отмена"
        tone="default"
        busy={busy}
        onConfirm={submitEndMatch}
      />
    </Card>
  );
}
