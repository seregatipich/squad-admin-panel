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
  TextInput,
} from '@/components/ui';
import { apiFetch, apiResult, describeHttpError } from '@/lib/api';
import {
  addCandidate,
  buildCandidatesPayload,
  buildSettingsPayload,
  type CatalogLayer,
  describeApiError,
  type MapVoteCandidate,
  type MapVoteResponse,
  type MapVoteSettingsForm,
  type PickRow,
  type PreviewResponse,
  removeCandidateAt,
  type VersionRow,
  validateCandidates,
  validateSettings,
} from './helpers';
import { PicksCard, PreviewCard, VersionsCard } from './MapVotePanels';

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

      <PreviewCard preview={preview} />

      <PicksCard picks={picks} />

      <VersionsCard
        versions={versions}
        canRestore={canRestore}
        saving={saving}
        pendingRestore={pendingRestore}
        onRestore={(versionId, dropUnknown) => void restoreVersion(versionId, dropUnknown)}
      />
    </PageContainer>
  );
}
