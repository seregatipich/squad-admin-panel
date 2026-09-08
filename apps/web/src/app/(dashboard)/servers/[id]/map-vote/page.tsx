'use client';

import { use, useCallback, useEffect, useState } from 'react';
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
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [meRes, stateRes, previewRes, picksRes, layersRes, versionsRes] = await Promise.all([
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
        fetch(`/api/v1/servers/${id}/map-vote/versions?limit=20`, {
          credentials: 'include',
          cache: 'no-store',
        }),
      ]);
      for (const res of [meRes, stateRes, previewRes, picksRes, layersRes, versionsRes]) {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      const me = (await meRes.json()) as Me;
      const state = (await stateRes.json()) as MapVoteResponse;
      const previewBody = (await previewRes.json()) as PreviewResponse;
      const picksBody = (await picksRes.json()) as { picks: PickRow[] };
      const layersBody = (await layersRes.json()) as { rows: CatalogLayer[] };
      const versionsBody = (await versionsRes.json()) as {
        can_restore: boolean;
        versions: VersionRow[];
      };

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
      setVersions(versionsBody.versions);
      setCanRestore(versionsBody.can_restore);
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
      const res = await fetch(`/api/v1/servers/${id}/map-vote/versions/${versionId}/restore`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ drop_unknown_layers: dropUnknown }),
      });
      if (res.status === 409) {
        const body = (await res.json()) as { layers?: string[] };
        const missing = (body.layers ?? []).join(', ');
        setErr(
          `В этой версии есть слои, которых больше нет в каталоге: ${missing}. Нажмите «Откатить без них», чтобы восстановить остальное.`,
        );
        setPendingRestore(versionId);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { count: number; dropped_layers: string[] };
      setPendingRestore(null);
      setMsg(
        body.dropped_layers.length > 0
          ? `Откат выполнен: ${body.count} слоёв, пропущено ${body.dropped_layers.length}`
          : `Откат выполнен: ${body.count} слоёв`,
      );
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

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
    return (
      <PageContainer width="wide">
        <Skeleton variant="card" count={3} label="Голосование за карту загружается" />
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
