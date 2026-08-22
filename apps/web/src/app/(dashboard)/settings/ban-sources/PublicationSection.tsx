'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  GroupedRow,
  InlineBanner,
  Skeleton,
  Switch,
} from '@/components/ui';

type PublishScope = 'all_active' | 'permanent_only';

interface PublicationSettings {
  enabled: boolean;
  publish_scope: PublishScope;
  updated_at: string | null;
}

const SCOPE_OPTIONS: ReadonlyArray<{ value: PublishScope; label: string }> = [
  { value: 'all_active', label: 'Все активные баны' },
  { value: 'permanent_only', label: 'Только перманентные' },
];

function formatUpdatedAt(iso: string | null): string {
  if (!iso) return 'ещё не изменялось';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'ещё не изменялось';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * «Публикация банлиста» (CBAN-5) — секция на `/settings/ban-sources`
 * управляющая outbound-федерацией: master-свитч и выбор, что публиковать
 * (все активные баны / только перманентные). Источник данных для другого
 * инстанса панели — `GET /api/v1/public/banlist`, требующий API-токен со
 * scope `banlist:read`. Скрывается целиком для пользователей без
 * `can_manage_ban_sources` (эндпоинт настроек отвечает 401/403).
 *
 * Переключатель и радиокнопки применяются не сразу, а по кнопке «Сохранить»:
 * выключение публикации мгновенно обрывает выдачу чужому инстансу, и такой
 * шаг оператор должен подтвердить осознанно.
 */
export function PublicationSection() {
  const [settings, setSettings] = useState<PublicationSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [scope, setScope] = useState<PublishScope>('all_active');
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/settings/banlist-publication', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PublicationSettings;
      setSettings(body);
      setEnabled(body.enabled);
      setScope(body.publish_scope);
    } catch (err) {
      setError(`Не удалось загрузить настройки публикации: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/v1/settings/banlist-publication', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, publish_scope: scope }),
      });
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(String(body.error ?? res.status));
      }
      const fresh = (await res.json()) as PublicationSettings;
      setSettings(fresh);
      setEnabled(fresh.enabled);
      setScope(fresh.publish_scope);
      setNotice('Настройки публикации банлиста сохранены.');
    } catch (err) {
      setError(`Не удалось сохранить настройки: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (hidden) return null;
  if (loading) {
    return (
      <Card>
        <Skeleton variant="block" count={2} label="Загрузка настроек публикации" />
      </Card>
    );
  }
  if (!settings) return null;

  return (
    <section className="space-y-2">
      <Card padding="none">
        <CardHeader
          title="Публикация банлиста"
          description="Отдаёт собственный список банов другому инстансу панели (CBAN-5) — федерация без центрального сервера."
        />

        {error || notice ? (
          <CardBody className="space-y-3 pb-0">
            {error ? (
              <InlineBanner tone="crit" title="Не удалось выполнить запрос" description={error} />
            ) : null}
            {notice ? <InlineBanner tone="good" title={notice} /> : null}
          </CardBody>
        ) : null}

        <div className="divide-y divide-line">
          <GroupedRow
            label="Публиковать банлист наружу"
            description="Master-свитч. Выключение мгновенно останавливает выдачу — токены со scope «banlist:read» начнут получать 404."
            control={
              <Switch
                label="Публиковать банлист наружу"
                checked={enabled}
                onChange={(next) => {
                  setEnabled(next);
                  setNotice(null);
                }}
              />
            }
          />
        </div>

        <CardBody>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-2xs uppercase tracking-[0.06em] text-ink-3">
              Что публиковать
            </legend>
            {SCOPE_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="flex min-h-7 cursor-pointer items-center gap-2 text-[13px] text-ink"
              >
                <input
                  type="radio"
                  name="banlist-publish-scope"
                  value={option.value}
                  checked={scope === option.value}
                  onChange={() => {
                    setScope(option.value);
                    setNotice(null);
                  }}
                  className="size-3.5 shrink-0 accent-accent"
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
        </CardBody>

        <CardFooter>
          <span className="mr-auto text-xs text-ink-3">
            Последнее изменение: {formatUpdatedAt(settings.updated_at)}
          </span>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Сохранить
          </Button>
        </CardFooter>
      </Card>

      <p className="px-1 text-xs text-ink-3">
        Список читается запросом{' '}
        <span className="break-all font-mono">
          GET /api/v1/public/banlist?format=squad_cfg|json
        </span>{' '}
        с API-токеном, имеющим scope <span className="font-mono">banlist:read</span> (Настройки →
        Токены).
      </p>
    </section>
  );
}
