'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  AlertDialog,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  FieldRow,
  InlineBanner,
  PageContainer,
  PageHeader,
  Skeleton,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  TextInput,
  Th,
} from '@/components/ui';
import { ApiError, apiFetch, apiResult, apiSend } from '@/lib/api';
import {
  type AltDetectionSettingsForm,
  isValidIpOrCidr,
  validateAltDetectionSettingsForm,
} from './helpers';

interface IgnoredIp {
  id: string;
  cidr: string;
  note: string | null;
  created_by: string | null;
  author_name: string | null;
  created_at: string;
}

interface AltDetectionSettingsView extends AltDetectionSettingsForm {
  updated_at: string | null;
  updated_by_player_id: string | null;
}

type Banner = { kind: 'ok' | 'err'; text: string } | null;

/** Banner text for a failed call: the HTTP status plus the API's `error` code. */
function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.jsonBody<Record<string, unknown>>() ?? {};
    return `HTTP ${error.status}: ${body.error ?? 'unknown'}`;
  }
  return (error as Error).message;
}

export default function AltDetectionPage() {
  const [settings, setSettings] = useState<AltDetectionSettingsView | null>(null);
  const [ignoredIps, setIgnoredIps] = useState<IgnoredIp[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  // Изменения требуют права player:manage_alt_detection, а не только «История IP».
  const [canEdit, setCanEdit] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  const [newCidr, setNewCidr] = useState('');
  const [newNote, setNewNote] = useState('');
  const [addingIp, setAddingIp] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<IgnoredIp | null>(null);
  const [deleting, setDeleting] = useState(false);

  const cidrInputId = useId();
  const noteInputId = useId();

  const load = useCallback(async () => {
    const result = await apiResult<{
      settings: AltDetectionSettingsView;
      ignored_ips: IgnoredIp[];
      can_edit: boolean;
    }>('/api/v1/settings/alt-detection');
    if (!result.ok) {
      if (result.error.status === 401 || result.error.status === 403) {
        setForbidden(true);
        return;
      }
      throw result.error;
    }
    setSettings(result.data.settings);
    setIgnoredIps(result.data.ignored_ips);
    setCanEdit(result.data.can_edit);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      await load();
      setBanner(null);
    } catch (e) {
      setBanner({ kind: 'err', text: describeFailure(e) });
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function addIgnoredIp(e: React.FormEvent) {
    e.preventDefault();
    const cidr = newCidr.trim();
    if (!isValidIpOrCidr(cidr)) {
      setBanner({ kind: 'err', text: 'Некорректный IP-адрес или CIDR-блок.' });
      return;
    }
    setAddingIp(true);
    setBanner(null);
    try {
      await apiSend('/api/v1/settings/alt-detection/ignored-ips', {
        method: 'POST',
        json: { cidr, note: newNote.trim() || undefined },
      });
      setNewCidr('');
      setNewNote('');
      await load();
      setBanner({ kind: 'ok', text: 'Исключение добавлено.' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setBanner({ kind: 'err', text: 'Этот адрес уже добавлен в исключения.' });
        return;
      }
      setBanner({ kind: 'err', text: describeFailure(e) });
    } finally {
      setAddingIp(false);
    }
  }

  async function deleteIgnoredIp(row: IgnoredIp) {
    setDeleting(true);
    setBanner(null);
    try {
      await apiSend(`/api/v1/settings/alt-detection/ignored-ips/${row.id}`, { method: 'DELETE' });
      setPendingDelete(null);
      await load();
      setBanner({ kind: 'ok', text: 'Исключение удалено.' });
    } catch (e) {
      setPendingDelete(null);
      setBanner({ kind: 'err', text: describeFailure(e) });
    } finally {
      setDeleting(false);
    }
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    const validationError = validateAltDetectionSettingsForm(settings);
    if (validationError) {
      setBanner({ kind: 'err', text: validationError });
      return;
    }
    setSavingSettings(true);
    setBanner(null);
    try {
      const updated = await apiFetch<AltDetectionSettingsView>('/api/v1/settings/alt-detection', {
        method: 'PUT',
        json: {
          weight_shared_ip: settings.weight_shared_ip,
          weight_shared_name: settings.weight_shared_name,
          weight_young_account: settings.weight_young_account,
          weight_steamid_proximity: settings.weight_steamid_proximity,
          weight_coplay_overlap: settings.weight_coplay_overlap,
          steamid_delta_threshold: settings.steamid_delta_threshold,
          medium_threshold: settings.medium_threshold,
          high_threshold: settings.high_threshold,
          coplay_overlap_threshold_seconds: settings.coplay_overlap_threshold_seconds,
        },
      });
      setSettings(updated);
      setBanner({ kind: 'ok', text: 'Параметры сохранены.' });
    } catch (e) {
      setBanner({ kind: 'err', text: describeFailure(e) });
    } finally {
      setSavingSettings(false);
    }
  }

  function updateField(field: keyof AltDetectionSettingsForm, value: string) {
    setSettings((prev) => (prev ? { ...prev, [field]: Number(value) || 0 } : prev));
  }

  if (forbidden) {
    return (
      <PageContainer width="reading">
        <PageHeader title="Детектор альтов" />
        <InlineBanner
          tone="crit"
          title="Недостаточно прав"
          description="Для просмотра детектора альтов нужен доступ «История IP»."
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Детектор альтов"
        subtitle="Настройки движка поиска кандидатов в альты по общим IP (см. карточку игрока → «Возможные альты»): исключения адресов из подсчёта очков и веса эвристик."
      />

      {canEdit ? null : (
        <InlineBanner
          tone="info"
          title="Только просмотр"
          description="Менять веса, пороги и исключения может роль с доступом «История IP» и правом редактировать роли."
        />
      )}
      {banner?.kind === 'ok' ? (
        <InlineBanner
          tone="good"
          title={banner.text}
          onDismiss={() => setBanner(null)}
          dismissLabel="Скрыть сообщение"
        />
      ) : null}
      {banner?.kind === 'err' ? (
        <InlineBanner
          tone="crit"
          title="Не удалось выполнить запрос"
          description={banner.text}
          action={
            <Button size="sm" onClick={() => void reload()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      <Card padding="none">
        <CardHeader
          title="Игнорируемые IP и подсети"
          count={loading ? undefined : ignoredIps.length}
          description="Совпадения по этим адресам (VPN, CGNAT, интернет-кафе…) видны в списке кандидатов, но не увеличивают счёт."
        />
        {loading ? (
          <div className="p-3">
            <SkeletonTable rows={4} cols={5} label="Загрузка исключений" />
          </div>
        ) : ignoredIps.length === 0 ? (
          <EmptyState
            title="Исключений пока нет"
            description="Каждый адрес из этого списка перестаёт добавлять очки кандидату в альты."
          />
        ) : (
          <Table ariaLabel="Игнорируемые IP и подсети">
            <TableHead>
              <tr>
                <Th>CIDR</Th>
                <Th>Заметка</Th>
                <Th>Кто добавил</Th>
                <Th>Добавлено</Th>
                <Th align="right">
                  <span className="sr-only">Действия</span>
                </Th>
              </tr>
            </TableHead>
            <TableBody>
              {ignoredIps.map((row) => (
                <TableRow key={row.id}>
                  <Td className="font-mono text-xs">{row.cidr}</Td>
                  <Td className="text-ink-2">{row.note ?? '—'}</Td>
                  <Td className="text-ink-3">{row.author_name ?? 'Система'}</Td>
                  <Td className="whitespace-nowrap text-ink-3">
                    {new Date(row.created_at).toLocaleString('ru-RU')}
                  </Td>
                  <Td align="right">
                    {canEdit ? (
                      <Button size="sm" disabled={deleting} onClick={() => setPendingDelete(row)}>
                        Удалить
                      </Button>
                    ) : null}
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {canEdit ? (
          <form onSubmit={addIgnoredIp}>
            <CardBody className="flex flex-wrap items-end gap-3 border-t border-line">
              <FieldRow label="IP или CIDR" htmlFor={cidrInputId} className="w-48">
                <TextInput
                  id={cidrInputId}
                  type="text"
                  value={newCidr}
                  onChange={(e) => setNewCidr(e.target.value)}
                  placeholder="10.0.0.0/24"
                />
              </FieldRow>
              <FieldRow
                label="Заметка"
                htmlFor={noteInputId}
                hint="VPN, CGNAT, интернет-кафе…"
                className="w-64"
              >
                <TextInput
                  id={noteInputId}
                  type="text"
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  maxLength={500}
                />
              </FieldRow>
              <Button
                type="submit"
                variant="primary"
                loading={addingIp}
                disabled={newCidr.trim() === ''}
              >
                Добавить
              </Button>
            </CardBody>
          </form>
        ) : null}
      </Card>

      <Card padding="none">
        <CardHeader
          title="Параметры оценки"
          description="Вес каждого сигнала прибавляется к счёту кандидата один раз, если сигнал сработал. Итоговый счёт определяет уровень доверия: низкий — ниже порога «средний», средний — между порогами, высокий — на пороге «высокий» и выше."
        />
        {loading || !settings ? (
          <CardBody>
            <Skeleton variant="block" count={3} label="Загрузка параметров" />
          </CardBody>
        ) : (
          <form onSubmit={saveSettings}>
            <CardBody>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <NumberField
                  disabled={!canEdit}
                  label="Вес: общий IP"
                  value={settings.weight_shared_ip}
                  onChange={(v) => updateField('weight_shared_ip', v)}
                />
                <NumberField
                  disabled={!canEdit}
                  label="Вес: общий ник"
                  value={settings.weight_shared_name}
                  onChange={(v) => updateField('weight_shared_name', v)}
                />
                <NumberField
                  disabled={!canEdit}
                  label="Вес: молодой аккаунт"
                  value={settings.weight_young_account}
                  onChange={(v) => updateField('weight_young_account', v)}
                />
                <NumberField
                  disabled={!canEdit}
                  label="Вес: близкий SteamID64"
                  value={settings.weight_steamid_proximity}
                  onChange={(v) => updateField('weight_steamid_proximity', v)}
                />
                <NumberField
                  disabled={!canEdit}
                  label="Вес: совместная игра"
                  value={settings.weight_coplay_overlap}
                  onChange={(v) => updateField('weight_coplay_overlap', v)}
                />
                <NumberField
                  disabled={!canEdit}
                  label="Порог дельты SteamID64"
                  value={settings.steamid_delta_threshold}
                  onChange={(v) => updateField('steamid_delta_threshold', v)}
                />
                <NumberField
                  disabled={!canEdit}
                  label="Порог совместной игры (сек)"
                  value={settings.coplay_overlap_threshold_seconds}
                  onChange={(v) => updateField('coplay_overlap_threshold_seconds', v)}
                />
                <NumberField
                  disabled={!canEdit}
                  label="Порог доверия: средний"
                  value={settings.medium_threshold}
                  onChange={(v) => updateField('medium_threshold', v)}
                />
                <NumberField
                  disabled={!canEdit}
                  label="Порог доверия: высокий"
                  value={settings.high_threshold}
                  onChange={(v) => updateField('high_threshold', v)}
                />
              </div>
            </CardBody>
            {canEdit ? (
              <CardFooter>
                <Button type="submit" variant="primary" loading={savingSettings}>
                  Сохранить
                </Button>
              </CardFooter>
            ) : null}
          </form>
        )}
      </Card>

      <AlertDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Удалить исключение"
        body={
          <>
            Адрес «{pendingDelete?.cidr}» снова начнёт добавлять очки кандидатам в альты. Исключение
            можно завести заново.
          </>
        }
        confirmLabel="Удалить исключение"
        cancelLabel="Отмена"
        tone="destructive"
        busy={deleting}
        onConfirm={() => {
          if (pendingDelete) void deleteIgnoredIp(pendingDelete);
        }}
      />
    </PageContainer>
  );
}

/** Числовой параметр оценки: подпись, поле и общий для страницы шаг вёрстки. */
function NumberField(props: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <FieldRow label={props.label} htmlFor={id}>
      <TextInput
        id={id}
        type="number"
        min={0}
        disabled={props.disabled}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </FieldRow>
  );
}
