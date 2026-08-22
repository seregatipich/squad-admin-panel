'use client';

import { useCallback, useEffect, useId, useState } from 'react';

interface GeoipSettings {
  account_id: string | null;
  license_key_configured: boolean;
  license_key_mask: string | null;
  enabled: boolean;
  db_present: boolean;
  last_refreshed_at: string | null;
  updated_at: string | null;
}

type Banner = { kind: 'ok' | 'err'; text: string } | null;

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(`HTTP ${res.status}: ${body.error ?? 'unknown'}`);
  }
  return (await res.json()) as T;
}

export default function GeoipIntegrationPage() {
  const accountFieldId = useId();
  const licenseFieldId = useId();
  const [settings, setSettings] = useState<GeoipSettings | null>(null);
  const [accountId, setAccountId] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await readJson<GeoipSettings>(
        await fetch('/api/v1/integrations/geoip', { credentials: 'include', cache: 'no-store' }),
      );
      setSettings(data);
      setAccountId(data.account_id ?? '');
      setEnabled(data.enabled);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function save() {
    setSaving(true);
    setBanner(null);
    try {
      const payload: Record<string, unknown> = { account_id: accountId.trim() || null, enabled };
      if (licenseKey.trim().length > 0) payload.license_key = licenseKey.trim();
      await readJson<GeoipSettings>(
        await fetch('/api/v1/integrations/geoip', {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      );
      setLicenseKey('');
      await reload();
      setBanner({ kind: 'ok', text: 'Сохранено.' });
    } catch (e) {
      setBanner({ kind: 'err', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    if (!confirm('Удалить ключ MaxMind? GeoIP-резолвинг будет отключён.')) return;
    setSaving(true);
    setBanner(null);
    try {
      await readJson<GeoipSettings>(
        await fetch('/api/v1/integrations/geoip', {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ license_key: null, enabled: false }),
        }),
      );
      setLicenseKey('');
      await reload();
      setBanner({ kind: 'ok', text: 'Ключ удалён.' });
    } catch (e) {
      setBanner({ kind: 'err', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  if (err) {
    return (
      <div className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
        Ошибка: {err}
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">GeoIP (MaxMind)</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Введите MaxMind Account ID и License Key — панель скачает базу GeoLite2-City и будет
          определять страну/город по IP. Без ключа IP сохраняется, но геоданные остаются пустыми.
        </p>
      </div>

      {banner ? (
        <div
          className={`rounded border p-2 text-xs ${
            banner.kind === 'ok'
              ? 'border-emerald-900 bg-emerald-950/50 text-emerald-200'
              : 'border-red-900 bg-red-950 text-red-200'
          }`}
        >
          {banner.text}
        </div>
      ) : null}

      <section className="space-y-4 rounded border border-neutral-800 bg-neutral-950 p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-neutral-400">Статус</span>
          <span
            className={settings?.license_key_configured ? 'text-emerald-300' : 'text-neutral-500'}
          >
            {settings?.license_key_configured ? 'Ключ настроен' : 'Ключ не настроен'}
            {settings?.db_present ? ' · база загружена' : ' · база не загружена'}
          </span>
        </div>

        <div className="space-y-1">
          <label
            htmlFor={accountFieldId}
            className="text-xs uppercase tracking-widest text-neutral-500"
          >
            Account ID
          </label>
          <input
            id={accountFieldId}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder="123456"
            className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-1">
          <label
            htmlFor={licenseFieldId}
            className="text-xs uppercase tracking-widest text-neutral-500"
          >
            License Key
          </label>
          <input
            id={licenseFieldId}
            type="password"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            placeholder={
              settings?.license_key_configured ? (settings.license_key_mask ?? '') : 'lic-key'
            }
            className="w-full rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm font-mono"
          />
          <p className="text-xs text-neutral-500">
            Оставьте поле пустым, чтобы сохранить текущий ключ.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4"
          />
          Включить GeoIP-резолвинг
        </label>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-500 disabled:opacity-40"
          >
            Сохранить
          </button>
          {settings?.license_key_configured ? (
            <button
              type="button"
              onClick={() => void clearKey()}
              disabled={saving}
              className="rounded border border-red-900 px-4 py-2 text-sm text-red-400 hover:border-red-700 disabled:opacity-40"
            >
              Удалить ключ
            </button>
          ) : null}
        </div>

        {settings?.last_refreshed_at ? (
          <p className="text-xs text-neutral-500">
            База обновлена: {new Date(settings.last_refreshed_at).toLocaleString()}
          </p>
        ) : null}
      </section>
    </div>
  );
}
