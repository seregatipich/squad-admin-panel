'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { RoleColorDot } from '@/components/RoleColorDot';
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

  if (!settings || !me) {
    return <div className="text-neutral-500">Загрузка…</div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Whitelist</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Выберите роль, которая используется для whitelist. Добавление и снятие игрока с whitelist
          — это выдача/снятие этой роли (та же модель, что и обычные роли панели).
        </p>
      </header>

      {err ? (
        <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          {err}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded border border-emerald-900 bg-emerald-950 p-3 text-sm text-emerald-200">
          {notice}
        </div>
      ) : null}
      {!canEdit ? (
        <div className="rounded border border-neutral-800 bg-neutral-900/60 p-3 text-sm text-neutral-400">
          Просмотр доступен, но для изменения whitelist нужно право «Управлять whitelist».
        </div>
      ) : null}

      <section className="rounded-lg border border-neutral-800 bg-neutral-950 p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
          Роль whitelist
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          {settings.whitelist_role_id ? (
            <span className="inline-flex items-center gap-2 text-sm">
              <RoleColorDot
                color={roleOptions.find((r) => r.id === settings.whitelist_role_id)?.color ?? ''}
              />
              <span className="font-medium">{settings.whitelist_role_name}</span>
            </span>
          ) : (
            <span className="text-sm text-neutral-500">роль не выбрана</span>
          )}
          {settings.whitelist_role_id ? (
            <Link
              href={`/settings/groups/${settings.whitelist_role_id}/members`}
              className="text-xs text-sky-400 hover:text-sky-300"
            >
              Список участников →
            </Link>
          ) : null}
        </div>

        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm"
            >
              <option value="">— не выбрана —</option>
              {assignableRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={saveRole}
              disabled={saving || picked === (settings.whitelist_role_id ?? '')}
              className="rounded-md border border-sky-700 bg-sky-950 px-3 py-1.5 text-sm text-sky-200 hover:bg-sky-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-neutral-800 bg-neutral-950 p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
          Импорт CSV
        </h2>
        <p className="text-xs text-neutral-500">
          Формат: одна строка на игрока — <code>SteamID64[,комментарий]</code>. Строки без валидного
          SteamID64 или с неизвестным игроком будут пропущены и показаны ниже.
        </p>
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          disabled={!canEdit}
          rows={6}
          placeholder={'76561198000000001,комментарий\n76561198000000002'}
          className="w-full resize-y rounded border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-60"
        />
        {canEdit ? (
          <button
            type="button"
            onClick={importCsv}
            disabled={importing || !csv.trim() || !settings.whitelist_role_id}
            className="rounded-md border border-sky-700 bg-sky-950 px-3 py-1.5 text-sm text-sky-200 hover:bg-sky-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {importing ? 'Импортируем…' : 'Импортировать'}
          </button>
        ) : null}
        {canEdit && !settings.whitelist_role_id ? (
          <p className="text-xs text-amber-400/90">
            Сначала выберите роль whitelist — импорт недоступен без неё.
          </p>
        ) : null}

        {importResult ? (
          <div className="space-y-2 text-sm">
            <div className="text-neutral-300">
              Импортировано {importResult.imported} из {importResult.total_rows}
              {importResult.skipped.length > 0 ? `, пропущено ${importResult.skipped.length}` : ''}.
            </div>
            {importResult.skipped.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-left uppercase tracking-widest text-neutral-500">
                    <tr>
                      <th className="p-1">Строка</th>
                      <th className="p-1">Содержимое</th>
                      <th className="p-1">Причина</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importResult.skipped.map((row) => (
                      <tr key={row.line} className="border-t border-neutral-900">
                        <td className="p-1 font-mono">{row.line}</td>
                        <td className="p-1 font-mono">{row.raw}</td>
                        <td className="p-1 text-amber-400/90">{SKIP_REASON_LABEL[row.reason]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-neutral-800 bg-neutral-950 p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-neutral-500">
          Экспорт CSV
        </h2>
        <a
          href="/api/v1/whitelist/export"
          className="inline-block rounded border border-neutral-800 px-3 py-1.5 text-sm text-neutral-200 no-underline hover:border-neutral-600"
        >
          Скачать whitelist.csv
        </a>
      </section>

      <ApplicationsSection canEdit={canEdit} />
    </div>
  );
}
