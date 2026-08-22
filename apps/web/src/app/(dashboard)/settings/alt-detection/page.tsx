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

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(`HTTP ${res.status}: ${body.error ?? 'unknown'}`);
  }
  return (await res.json()) as T;
}

export default function AltDetectionPage() {
  const [settings, setSettings] = useState<AltDetectionSettingsView | null>(null);
  const [ignoredIps, setIgnoredIps] = useState<IgnoredIp[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
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
    const res = await fetch('/api/v1/settings/alt-detection', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (res.status === 401 || res.status === 403) {
      setForbidden(true);
      return;
    }
    const body = await readJson<{ settings: AltDetectionSettingsView; ignored_ips: IgnoredIp[] }>(
      res,
    );
    setSettings(body.settings);
    setIgnoredIps(body.ignored_ips);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      await load();
      setBanner(null);
    } catch (e) {
      setBanner({ kind: 'err', text: (e as Error).message });
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
      const res = await fetch('/api/v1/settings/alt-detection/ignored-ips', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cidr, note: newNote.trim() || undefined }),
      });
      if (res.status === 409) {
        setBanner({ kind: 'err', text: 'Этот адрес уже добавлен в исключения.' });
        return;
      }
      await readJson(res);
      setNewCidr('');
      setNewNote('');
      await load();
      setBanner({ kind: 'ok', text: 'Исключение добавлено.' });
    } catch (e) {
      setBanner({ kind: 'err', text: (e as Error).message });
    } finally {
      setAddingIp(false);
    }
  }

  async function deleteIgnoredIp(row: IgnoredIp) {
    setDeleting(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/v1/settings/alt-detection/ignored-ips/${row.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      await readJson(res);
      setPendingDelete(null);
      await load();
      setBanner({ kind: 'ok', text: 'Исключение удалено.' });
    } catch (e) {
      setPendingDelete(null);
      setBanner({ kind: 'err', text: (e as Error).message });
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
      const res = await fetch('/api/v1/settings/alt-detection', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          weight_shared_ip: settings.weight_shared_ip,
          weight_shared_name: settings.weight_shared_name,
          weight_young_account: settings.weight_young_account,
          weight_steamid_proximity: settings.weight_steamid_proximity,
          steamid_delta_threshold: settings.steamid_delta_threshold,
          medium_threshold: settings.medium_threshold,
          high_threshold: settings.high_threshold,
        }),
      });
      const updated = await readJson<AltDetectionSettingsView>(res);
      setSettings(updated);
      setBanner({ kind: 'ok', text: 'Параметры сохранены.' });
    } catch (e) {
      setBanner({ kind: 'err', text: (e as Error).message });
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
                    <Button size="sm" disabled={deleting} onClick={() => setPendingDelete(row)}>
                      Удалить
                    </Button>
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
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
                  label="Вес: общий IP"
                  value={settings.weight_shared_ip}
                  onChange={(v) => updateField('weight_shared_ip', v)}
                />
                <NumberField
                  label="Вес: общий ник"
                  value={settings.weight_shared_name}
                  onChange={(v) => updateField('weight_shared_name', v)}
                />
                <NumberField
                  label="Вес: молодой аккаунт"
                  value={settings.weight_young_account}
                  onChange={(v) => updateField('weight_young_account', v)}
                />
                <NumberField
                  label="Вес: близкий SteamID64"
                  value={settings.weight_steamid_proximity}
                  onChange={(v) => updateField('weight_steamid_proximity', v)}
                />
                <NumberField
                  label="Порог дельты SteamID64"
                  value={settings.steamid_delta_threshold}
                  onChange={(v) => updateField('steamid_delta_threshold', v)}
                />
                <NumberField
                  label="Порог доверия: средний"
                  value={settings.medium_threshold}
                  onChange={(v) => updateField('medium_threshold', v)}
                />
                <NumberField
                  label="Порог доверия: высокий"
                  value={settings.high_threshold}
                  onChange={(v) => updateField('high_threshold', v)}
                />
              </div>
            </CardBody>
            <CardFooter>
              <Button type="submit" variant="primary" loading={savingSettings}>
                Сохранить
              </Button>
            </CardFooter>
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
function NumberField(props: { label: string; value: number; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <FieldRow label={props.label} htmlFor={id}>
      <TextInput
        id={id}
        type="number"
        min={0}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </FieldRow>
  );
}
