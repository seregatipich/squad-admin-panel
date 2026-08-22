'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  FieldRow,
  InlineBanner,
  PageContainer,
  PageHeader,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Textarea,
  Th,
} from '@/components/ui';
import { ApplicationsSection } from './ApplicationsSection';

interface WhitelistSettings {
  whitelist_role_id: string | null;
  whitelist_role_name: string | null;
}

interface RoleOption {
  id: string;
  name: string;
  color: string;
  is_system_role: boolean;
}

interface ImportSkippedRow {
  line: number;
  raw: string;
  reason: 'malformed_row' | 'invalid_steam_id64' | 'player_not_found';
}

interface ImportResult {
  total_rows: number;
  imported: number;
  skipped: ImportSkippedRow[];
}

interface Me {
  permissions: string[];
}

const SKIP_REASON_LABEL: Record<ImportSkippedRow['reason'], string> = {
  malformed_row: 'некорректная строка',
  invalid_steam_id64: 'некорректный SteamID64',
  player_not_found: 'игрок не найден',
};

export default function WhitelistSettingsPage() {
  const [settings, setSettings] = useState<WhitelistSettings | null>(null);
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [picked, setPicked] = useState('');
  const [saving, setSaving] = useState(false);
  const [csv, setCsv] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const roleSelectId = useId();
  const csvId = useId();

  const refresh = useCallback(async () => {
    const [settingsRes, rolesRes, meRes] = await Promise.all([
      fetch('/api/v1/whitelist/settings', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/roles', { credentials: 'include', cache: 'no-store' }),
      fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
    ]);
    if (settingsRes.ok) {
      const loaded = (await settingsRes.json()) as WhitelistSettings;
      setSettings(loaded);
      setPicked(loaded.whitelist_role_id ?? '');
      setErr(null);
    } else {
      setErr(`Не удалось загрузить настройки: ${settingsRes.status}`);
    }
    if (rolesRes.ok) setRoleOptions((await rolesRes.json()) as RoleOption[]);
    if (meRes.ok) setMe((await meRes.json()) as Me);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canEdit = me?.permissions.includes('whitelist:edit') ?? false;
  const assignableRoles = roleOptions.filter((r) => !(r.is_system_role && r.name === 'Owner'));

  async function saveRole() {
    if (!canEdit) return;
    setSaving(true);
    setErr(null);
    setNotice(null);
    try {
      const res = await fetch('/api/v1/whitelist/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ whitelist_role_id: picked || null }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setErr(`Ошибка сохранения: ${e.error ?? res.status}`);
        return;
      }
      const fresh = (await res.json()) as WhitelistSettings;
      setSettings(fresh);
      setNotice('Роль для whitelist сохранена.');
    } catch (e) {
      setErr(`Ошибка сети: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function importCsv() {
    if (!canEdit || !csv.trim()) return;
    setImporting(true);
    setErr(null);
    setImportResult(null);
    try {
      const res = await fetch('/api/v1/whitelist/import', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csv }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setErr(`Ошибка импорта: ${e.error ?? res.status}`);
        return;
      }
      setImportResult((await res.json()) as ImportResult);
    } catch (e) {
      setErr(`Ошибка сети: ${(e as Error).message}`);
    } finally {
      setImporting(false);
    }
  }

  return (
    <PageContainer width="reading">
      <PageHeader
        title="Whitelist"
        subtitle="Выберите роль, которая используется для whitelist. Добавление и снятие игрока с whitelist — это выдача/снятие этой роли (та же модель, что и обычные роли панели)."
      />

      {err ? (
        <InlineBanner
          tone="crit"
          title="Не удалось выполнить запрос"
          description={err}
          action={
            <Button size="sm" onClick={() => void refresh()}>
              Повторить
            </Button>
          }
        />
      ) : null}
      {notice ? (
        <InlineBanner
          tone="good"
          title={notice}
          onDismiss={() => setNotice(null)}
          dismissLabel="Скрыть сообщение"
        />
      ) : null}
      {settings && me && !canEdit ? (
        <InlineBanner
          tone="info"
          title="Только просмотр"
          description="Для изменения whitelist нужно право «Управлять whitelist»."
        />
      ) : null}

      {!settings || !me ? (
        <Card>
          <Skeleton variant="block" count={3} label="Загрузка настроек whitelist" />
        </Card>
      ) : (
        <>
          <Card padding="none">
            <CardHeader title="Роль whitelist" />
            <CardBody className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                {settings.whitelist_role_id ? (
                  <span className="inline-flex items-center gap-2 text-[13px]">
                    <RoleColorDot
                      color={
                        roleOptions.find((r) => r.id === settings.whitelist_role_id)?.color ?? ''
                      }
                    />
                    <span className="font-medium">{settings.whitelist_role_name}</span>
                  </span>
                ) : (
                  <span className="text-xs text-ink-3">Роль не выбрана</span>
                )}
                {settings.whitelist_role_id ? (
                  <Link
                    href={`/settings/groups/${settings.whitelist_role_id}/members`}
                    className="text-xs text-accent no-underline hover:brightness-110"
                  >
                    Список участников
                  </Link>
                ) : null}
              </div>

              {canEdit ? (
                <FieldRow label="Роль для whitelist" htmlFor={roleSelectId}>
                  <Select
                    id={roleSelectId}
                    value={picked}
                    onChange={(e) => setPicked(e.target.value)}
                  >
                    <option value="">— не выбрана —</option>
                    {assignableRoles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </FieldRow>
              ) : null}
            </CardBody>
            {canEdit ? (
              <CardFooter>
                <Button
                  variant="primary"
                  loading={saving}
                  disabled={picked === (settings.whitelist_role_id ?? '')}
                  onClick={() => void saveRole()}
                >
                  Сохранить
                </Button>
              </CardFooter>
            ) : null}
          </Card>

          <Card padding="none">
            <CardHeader title="Импорт CSV" />
            <CardBody className="space-y-3">
              <FieldRow
                label="Строки CSV"
                htmlFor={csvId}
                hint={
                  <>
                    Формат: одна строка на игрока — <code>SteamID64[,комментарий]</code>. Строки без
                    корректного SteamID64 или с неизвестным игроком будут пропущены и показаны ниже.
                  </>
                }
              >
                <Textarea
                  id={csvId}
                  value={csv}
                  onChange={(e) => setCsv(e.target.value)}
                  disabled={!canEdit}
                  rows={6}
                  placeholder={'76561198000000001,комментарий\n76561198000000002'}
                  className="resize-y font-mono"
                />
              </FieldRow>

              {canEdit && !settings.whitelist_role_id ? (
                <InlineBanner
                  tone="warn"
                  title="Сначала выберите роль whitelist"
                  description="Без выбранной роли импорт недоступен."
                />
              ) : null}

              {importResult ? (
                <div className="space-y-3">
                  <p className="text-[13px]">
                    Импортировано {importResult.imported} из {importResult.total_rows}
                    {importResult.skipped.length > 0
                      ? `, пропущено ${importResult.skipped.length}`
                      : ''}
                    .
                  </p>
                  {importResult.skipped.length > 0 ? (
                    <Table dense ariaLabel="Пропущенные строки импорта">
                      <TableHead>
                        <tr>
                          <Th align="right" width="5rem">
                            Строка
                          </Th>
                          <Th>Содержимое</Th>
                          <Th>Причина</Th>
                        </tr>
                      </TableHead>
                      <TableBody>
                        {importResult.skipped.map((row) => (
                          <TableRow key={row.line} tone="warn">
                            <Td numeric className="font-mono">
                              {row.line}
                            </Td>
                            <Td className="break-all font-mono text-xs">{row.raw}</Td>
                            <Td className="text-ink-2">{SKIP_REASON_LABEL[row.reason]}</Td>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : null}
                </div>
              ) : null}
            </CardBody>
            {canEdit ? (
              <CardFooter>
                <Button
                  variant="primary"
                  loading={importing}
                  disabled={!csv.trim() || !settings.whitelist_role_id}
                  onClick={() => void importCsv()}
                >
                  Импортировать
                </Button>
              </CardFooter>
            ) : null}
          </Card>

          <Card padding="none">
            <CardHeader title="Экспорт CSV" />
            <CardBody>
              {/* Настоящий `<a>`: адрес отдаёт файл, а не страницу приложения. */}
              <a
                href="/api/v1/whitelist/export"
                className="inline-flex h-8 items-center rounded-ctl border border-line bg-raised px-3 text-xs font-medium text-ink no-underline transition-colors duration-150 hover:bg-line-2"
              >
                Скачать whitelist.csv
              </a>
            </CardBody>
          </Card>

          <ApplicationsSection canEdit={canEdit} />
        </>
      )}
    </PageContainer>
  );
}
