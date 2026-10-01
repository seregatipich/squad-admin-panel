'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  GroupedList,
  GroupedRow,
  InlineBanner,
  PageContainer,
  Select,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  TextInput,
  Th,
} from '@/components/ui';
import { apiFetch, apiResult, describeHttpError } from '@/lib/api';
import {
  addCandidate,
  buildCandidatesPayload,
  buildSettingsPayload,
  describeApiError,
  type MapVoteCandidate,
  type MapVoteSettingsForm,
  removeCandidateAt,
  validateCandidates,
  validateSettings,
} from './helpers';

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

interface VersionRow {
  id: string;
  sha256: string;
  parent_version_id: string | null;
  author: string | null;
  message: string | null;
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

/** Fetches an auxiliary block; a failed request yields `null` instead of failing the page. */
async function fetchOptional<T>(url: string): Promise<T | null> {
  try {
    return await apiFetch<T>(url);
  } catch {
    return null;
  }
}

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
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [canRestore, setCanRestore] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
  const [pool, setPool] = useState<CatalogLayer[]>([]);
  const [selectedLayer, setSelectedLayer] = useState('');
  const [confirmDeprecated, setConfirmDeprecated] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  /** Состояние с сервера не пришло — форму с дефолтами показывать нельзя. */
  const [stateLoaded, setStateLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Snapshots of what `load` last put into `form`/`candidates`, so a save in
  // one section can tell whether the *other* section has unsaved edits
  // before `load()` refetches everything: settings and candidates are saved
  // by two separate endpoints, but both come back from the one combined
  // GET /map-vote, and overwriting a still-dirty section with the server's
  // last-saved copy silently threw away whatever the operator was mid-typing
  // there (#624).
  const lastLoadedFormRef = useRef<string | null>(null);
  const lastLoadedCandidatesRef = useRef<string | null>(null);

  const load = useCallback(
    async (preserve: { settings?: boolean; candidates?: boolean } = {}) => {
      setErr(null);
      try {
        const state = await apiFetch<MapVoteResponse>(`/api/v1/servers/${id}/map-vote`);

        // Вспомогательные блоки грузятся независимо: их сбой не должен
        // ронять форму, у которой состояние уже есть.
        const [previewBody, picksBody, layersBody, versionsBody] = await Promise.all([
          fetchOptional<PreviewResponse>(`/api/v1/servers/${id}/map-vote/preview`),
          fetchOptional<{ picks: PickRow[] }>(`/api/v1/servers/${id}/map-vote/picks?limit=20`),
          fetchOptional<{ rows: CatalogLayer[] }>('/api/v1/layers'),
          fetchOptional<{ can_restore: boolean; versions: VersionRow[] }>(
            `/api/v1/servers/${id}/map-vote/versions?limit=20`,
          ),
        ]);

        const loadedForm: MapVoteSettingsForm = {
          enabled: state.enabled,
          selection: state.selection,
          layerCooldown: state.layer_cooldown,
          mapCooldown: state.map_cooldown,
          broadcastTemplate: state.broadcast_template ?? '',
        };
        lastLoadedFormRef.current = JSON.stringify(loadedForm);
        lastLoadedCandidatesRef.current = JSON.stringify(state.candidates);
        if (!preserve.settings) setForm(loadedForm);
        if (!preserve.candidates) setCandidates(state.candidates);
        setStateLoaded(true);
        setPreview(previewBody);
        setPicks(picksBody?.picks ?? []);
        setPool(layersBody?.rows ?? []);
        setVersions(versionsBody?.versions ?? []);
        setCanRestore(versionsBody?.can_restore ?? false);
        setCanEdit(state.can_edit);
      } catch (e) {
        setErr(describeHttpError(e));
      } finally {
        setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Откат к сохранённой версии. Слой мог исчезнуть из каталога с момента
   * сохранения — API отвечает 409 со списком таких слоёв, и повтор с
   * `drop_unknown_layers` возвращает остальное.
   */
  async function restoreVersion(versionId: string, dropUnknown = false) {
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiResult<{ count: number; dropped_layers?: string[] }>(
        `/api/v1/servers/${id}/map-vote/versions/${versionId}/restore`,
        { method: 'POST', json: { drop_unknown_layers: dropUnknown } },
      );
      if (!res.ok && res.error.status === 409) {
        const body = res.error.jsonBody<{ layers?: string[] }>() ?? {};
        const missing = (body.layers ?? []).join(', ');
        setErr(
          `В этой версии есть слои, которых больше нет в каталоге: ${missing}. Нажмите «Откатить без них», чтобы восстановить остальное.`,
        );
        setPendingRestore(versionId);
        return;
      }
      if (!res.ok) throw new Error(describeApiError(res.error));
      const body = res.data;
      const dropped = body.dropped_layers ?? [];
      setPendingRestore(null);
      setMsg(
        dropped.length > 0
          ? `Откат выполнен: ${body.count} слоёв, пропущено ${dropped.length}`
          : `Откат выполнен: ${body.count} слоёв`,
      );
      await load();
    } catch (e) {
      setErr(describeHttpError(e));
    } finally {
      setSaving(false);
    }
  }

  /** Enabled candidates last confirmed saved on the server, from `load`'s snapshot. */
  function savedEnabledCandidateCount(): number {
    if (!lastLoadedCandidatesRef.current) return 0;
    try {
      return (JSON.parse(lastLoadedCandidatesRef.current) as MapVoteCandidate[]).filter(
        (candidate) => candidate.enabled,
      ).length;
    } catch {
      return 0;
    }
  }

  async function saveSettings() {
    // Enabling autopick needs a *saved* candidate pool, not whatever is
    // sitting unsaved in the candidates editor below (#624) — the two
    // sections save through different endpoints, and the pool the operator
    // is mid-editing here may not exist on the server yet.
    const validation = validateSettings(form, savedEnabledCandidateCount());
    if (validation) {
      setErr(validation);
      return;
    }
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiResult<unknown>(`/api/v1/servers/${id}/map-vote/settings`, {
        method: 'PUT',
        json: buildSettingsPayload(form),
        discardBody: true,
      });
      if (!res.ok) throw new Error(describeApiError(res.error));
      setMsg('Настройки сохранены');
      // Candidates below may still be mid-edit and unsaved — reloading must
      // not silently discard them just because settings were saved (#624).
      const candidatesDirty = JSON.stringify(candidates) !== lastLoadedCandidatesRef.current;
      await load({ candidates: candidatesDirty });
    } catch (e) {
      setErr(describeHttpError(e));
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
      const res = await apiResult<unknown>(`/api/v1/servers/${id}/map-vote/candidates`, {
        method: 'PUT',
        json: buildCandidatesPayload(candidates, confirmDeprecated),
        discardBody: true,
      });
      if (!res.ok) throw new Error(describeApiError(res.error));
      setMsg('Кандидаты сохранены');
      // Settings above may still be mid-edit and unsaved (#624).
      const settingsDirty = JSON.stringify(form) !== lastLoadedFormRef.current;
      await load({ settings: settingsDirty });
    } catch (e) {
      setErr(describeHttpError(e));
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
    return (
      <PageContainer width="wide">
        <Skeleton variant="card" count={3} label="Голосование за карту загружается" />
      </PageContainer>
    );
  }

  if (!stateLoaded) {
    return (
      <PageContainer width="wide">
        <InlineBanner
          tone="crit"
          title={err ?? 'Не удалось загрузить голосование за карту'}
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="wide">
      <p className="text-xs text-ink-3">
        Автовыбор следующего слоя: панель выбирает из пула кандидатов и отправляет{' '}
        <span className="font-mono">AdminSetNextLayer</span> раз в матч.
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

      <div className="space-y-3">
        <GroupedList
          title="Настройки"
          footnote="Кулдаун считается в матчах: слой или карта не повторяются, пока не пройдёт указанное число матчей."
        >
          <GroupedRow
            label="Автовыбор включён"
            description={form.enabled ? 'Панель выбирает слой сама' : 'Выбор слоя остаётся ручным'}
            control={
              <Switch
                checked={form.enabled}
                disabled={!canEdit}
                label="Автовыбор включён"
                onChange={(next) => setForm((f) => ({ ...f, enabled: next }))}
              />
            }
          />
          <GroupedRow
            label="Правило выбора"
            control={
              <div className="w-56">
                <Select
                  value={form.selection}
                  disabled={!canEdit}
                  aria-label="Правило выбора"
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      selection: e.target.value as MapVoteSettingsForm['selection'],
                    }))
                  }
                >
                  <option value="weighted_random">Взвешенный случайный</option>
                  <option value="least_recently_played">Давно не игравшийся</option>
                </Select>
              </div>
            }
          />
          <GroupedRow
            label="Кулдаун слоя"
            description="В матчах"
            control={
              <div className="w-24">
                <TextInput
                  type="number"
                  value={form.layerCooldown}
                  disabled={!canEdit}
                  aria-label="Кулдаун слоя (матчей)"
                  onChange={(e) =>
                    setForm((f) => ({ ...f, layerCooldown: Number(e.target.value) }))
                  }
                />
              </div>
            }
          />
          <GroupedRow
            label="Кулдаун карты"
            description="В матчах"
            control={
              <div className="w-24">
                <TextInput
                  type="number"
                  value={form.mapCooldown}
                  disabled={!canEdit}
                  aria-label="Кулдаун карты (матчей)"
                  onChange={(e) => setForm((f) => ({ ...f, mapCooldown: Number(e.target.value) }))}
                />
              </div>
            }
          />
          <GroupedRow
            label="Шаблон объявления"
            description="Необязательно"
            control={
              <div className="w-72">
                <TextInput
                  type="text"
                  value={form.broadcastTemplate}
                  disabled={!canEdit}
                  aria-label="Шаблон объявления"
                  placeholder="Следующая карта: {layer}"
                  onChange={(e) => setForm((f) => ({ ...f, broadcastTemplate: e.target.value }))}
                />
              </div>
            }
          />
        </GroupedList>
        {canEdit ? (
          <div className="flex justify-end">
            <Button variant="primary" onClick={saveSettings} loading={saving}>
              Сохранить настройки
            </Button>
          </div>
        ) : null}
      </div>

      <Card padding="none">
        <CardHeader title="Кандидаты" count={candidates.length} />
        <ul className="divide-y divide-line" data-testid="candidates-list">
          {candidates.length === 0 ? (
            <li>
              <EmptyState
                title="Пул кандидатов пуст"
                description="Добавьте слои из каталога — панель выбирает следующую карту только из этого списка."
              />
            </li>
          ) : null}
          {candidates.map((candidate, index) => (
            <li
              key={candidate.layer}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-2"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] text-ink">{candidate.layer}</span>
                  {candidate.deprecated ? <Badge tone="warn">Устаревший</Badge> : null}
                </div>
                {candidate.map ? (
                  <div className="text-xs text-ink-3">
                    {candidate.map} · {candidate.gamemode}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="w-20">
                  <TextInput
                    type="number"
                    value={candidate.weight}
                    disabled={!canEdit}
                    aria-label={`Вес ${candidate.layer}`}
                    onChange={(e) => updateCandidate(index, { weight: Number(e.target.value) })}
                  />
                </div>
                <Checkbox
                  label="Участвует"
                  checked={candidate.enabled}
                  disabled={!canEdit}
                  onChange={(e) => updateCandidate(index, { enabled: e.target.checked })}
                />
                {canEdit ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCandidates((prev) => removeCandidateAt(prev, index))}
                  >
                    Удалить
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {canEdit ? (
          <CardBody className="space-y-3 border-t border-line">
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-64">
                <Select
                  value={selectedLayer}
                  onChange={(e) => setSelectedLayer(e.target.value)}
                  aria-label="Слой из каталога"
                >
                  <option value="">Выберите слой…</option>
                  {pool.map((layer) => (
                    <option key={layer.id} value={layer.name}>
                      {layer.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button onClick={handleAddCandidate} disabled={selectedLayer === ''}>
                Добавить слой
              </Button>
            </div>
            <Checkbox
              label="Подтвердить устаревшие слои"
              checked={confirmDeprecated}
              onChange={(e) => setConfirmDeprecated(e.target.checked)}
            />
            <div className="flex justify-end">
              <Button variant="primary" onClick={saveCandidates} loading={saving}>
                Сохранить кандидатов
              </Button>
            </div>
          </CardBody>
        ) : null}
      </Card>

      <Card padding="none">
        <CardHeader
          title="Предпросмотр выбора"
          description={
            preview?.would_pick
              ? `Сейчас был бы выбран слой ${preview.would_pick}`
              : 'Подходящих кандидатов нет'
          }
        />
        <CardBody className="space-y-4">
          {preview && preview.eligible.length > 0 ? (
            <div data-testid="preview-eligible">
              <Table ariaLabel="Кандидаты, участвующие в выборе">
                <TableHead sticky={false}>
                  <TableRow>
                    <Th>Слой</Th>
                    <Th align="right">Вес</Th>
                    <Th align="right">Вероятность</Th>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {preview.eligible.map((row) => (
                    <TableRow key={row.layer}>
                      <Td>
                        <span className="font-mono">{row.layer}</span>
                      </Td>
                      <Td numeric>{row.weight}</Td>
                      <Td numeric>{Math.round(row.probability * 100)}%</Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
          {preview && preview.excluded.length > 0 ? (
            <div data-testid="preview-excluded">
              <Table ariaLabel="Кандидаты, исключённые из выбора">
                <TableHead sticky={false}>
                  <TableRow>
                    <Th>Слой</Th>
                    <Th>Почему исключён</Th>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {preview.excluded.map((row) => (
                    <TableRow key={row.layer}>
                      <Td>
                        <span className="font-mono">{row.layer}</span>
                      </Td>
                      <Td>{EXCLUSION_LABELS[row.reason] ?? row.reason}</Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
          {!preview ? (
            <EmptyState
              title="Предпросмотр недоступен"
              description="Панель ещё не рассчитала, какой слой был бы выбран следующим."
            />
          ) : null}
        </CardBody>
      </Card>

      <Card padding="none">
        <CardHeader title="История выборов" count={picks.length} />
        {picks.length === 0 ? (
          <EmptyState
            title="Выборов ещё не было"
            description="Как только панель выберет слой, запись появится здесь."
          />
        ) : (
          <div data-testid="picks-list">
            <Table ariaLabel="История автоматических выборов слоя">
              <TableHead sticky={false}>
                <TableRow>
                  <Th>Слой</Th>
                  <Th>Когда</Th>
                  <Th>Результат</Th>
                </TableRow>
              </TableHead>
              <TableBody>
                {picks.map((pick) => (
                  <TableRow key={pick.id}>
                    <Td>
                      <span className="font-mono">{pick.layer}</span>
                    </Td>
                    <Td>{new Date(pick.created_at).toLocaleString('ru-RU')}</Td>
                    <Td>
                      {pick.applied ? (
                        <Badge tone="good">Применён</Badge>
                      ) : (
                        <Badge tone="warn">{pick.failure_reason ?? 'не применён'}</Badge>
                      )}
                    </Td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
      <Card padding="none">
        <CardHeader
          title="История изменений"
          count={versions.length}
          description="Каждое сохранение на этой странице попадает в ту же историю версий, что и правки конфигов: автор, время, отпечаток и откат."
        />
        {versions.length === 0 ? (
          <EmptyState
            title="Изменений ещё не было"
            description="Первая запись появится после сохранения правил или пула слоёв."
          />
        ) : (
          <div data-testid="versions-list">
            <Table ariaLabel="История изменений автовыбора карты">
              <TableHead sticky={false}>
                <TableRow>
                  <Th>Когда</Th>
                  <Th>Кто</Th>
                  <Th>Что изменилось</Th>
                  <Th>Отпечаток</Th>
                  {canRestore ? <Th align="right">Действия</Th> : null}
                </TableRow>
              </TableHead>
              <TableBody>
                {versions.map((version) => (
                  <TableRow key={version.id}>
                    <Td>{new Date(version.created_at).toLocaleString('ru-RU')}</Td>
                    <Td>{version.author ?? '—'}</Td>
                    <Td>{version.message ?? '—'}</Td>
                    <Td>
                      <span className="font-mono text-ink-3" title={version.sha256}>
                        {version.sha256.slice(0, 8)}
                      </span>
                    </Td>
                    {canRestore ? (
                      <Td align="right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            disabled={saving}
                            onClick={() => void restoreVersion(version.id)}
                          >
                            Откатить
                          </Button>
                          {pendingRestore === version.id ? (
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={saving}
                              onClick={() => void restoreVersion(version.id, true)}
                            >
                              Откатить без них
                            </Button>
                          ) : null}
                        </div>
                      </Td>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </PageContainer>
  );
}
