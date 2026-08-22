'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  FieldRow,
  GroupedList,
  GroupedRow,
  InlineBanner,
  PageHeader,
  TextInput,
} from '@/components/ui';

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
  const [settings, setSettings] = useState<GeoipSettings | null>(null);
  const [accountId, setAccountId] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [err, setErr] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await readJson<GeoipSettings>(
        await fetch('/api/v1/integrations/geoip', { credentials: 'include', cache: 'no-store' }),
      );
      setSettings(data);
      setAccountId(data.account_id ?? '');
      setEnabled(data.enabled);
      setErr(null);
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
      setClearing(false);
    }
  }

  return (
    <>
      <PageHeader
        title="GeoIP (MaxMind)"
        subtitle="Введите Account ID и License Key от MaxMind — панель скачает базу GeoLite2-City и будет определять страну и город по IP. Без ключа IP сохраняется, но геоданные остаются пустыми."
      />

      {err ? (
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить настройки GeoIP"
          description={err}
          action={
            <Button size="sm" onClick={() => void reload()}>
              Повторить
            </Button>
          }
        />
      ) : null}

      {banner ? (
        <InlineBanner tone={banner.kind === 'ok' ? 'good' : 'crit'} title={banner.text} />
      ) : null}

      <GroupedList title="Состояние">
        <GroupedRow
          label="Ключ MaxMind"
          control={
            <Badge tone={settings?.license_key_configured ? 'good' : 'neutral'}>
              {settings?.license_key_configured ? 'Настроен' : 'Не настроен'}
            </Badge>
          }
        />
        <GroupedRow
          label="База GeoLite2-City"
          control={
            <Badge tone={settings?.db_present ? 'good' : 'neutral'}>
              {settings?.db_present ? 'Загружена' : 'Не загружена'}
            </Badge>
          }
        />
        {settings?.last_refreshed_at ? (
          <GroupedRow
            label="База обновлена"
            control={
              <span className="text-xs text-ink-3">
                {new Date(settings.last_refreshed_at).toLocaleString('ru-RU')}
              </span>
            }
          />
        ) : null}
      </GroupedList>

      <Card padding="none">
        <CardHeader
          title="Доступ к MaxMind"
          description="Названия полей совпадают с личным кабинетом MaxMind, чтобы значения не пришлось искать по описанию."
        />
        <CardBody className="space-y-4">
          <FieldRow label="Account ID" hint="Идентификатор аккаунта из личного кабинета MaxMind.">
            <TextInput
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="123456"
            />
          </FieldRow>

          <FieldRow
            label="License Key"
            hint="Лицензионный ключ из личного кабинета MaxMind. Оставьте поле пустым, чтобы сохранить текущий."
          >
            <TextInput
              type="password"
              className="font-mono"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              placeholder={
                settings?.license_key_configured ? (settings.license_key_mask ?? '') : 'lic-key'
              }
            />
          </FieldRow>

          <Checkbox
            label="Включить GeoIP-резолвинг"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
        </CardBody>
        <CardFooter>
          {settings?.license_key_configured ? (
            <Button variant="secondary" disabled={saving} onClick={() => setClearing(true)}>
              Удалить ключ
            </Button>
          ) : null}
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Сохранить
          </Button>
        </CardFooter>
      </Card>

      <AlertDialog
        open={clearing}
        onClose={() => setClearing(false)}
        title="Удалить ключ MaxMind"
        body="Ключ будет стёрт, а GeoIP-резолвинг выключен: страна и город по IP определяться перестанут. Чтобы вернуть их, ключ придётся ввести заново."
        confirmLabel="Удалить ключ"
        cancelLabel="Отмена"
        tone="destructive"
        busy={saving}
        onConfirm={() => void clearKey()}
      />
    </>
  );
}
