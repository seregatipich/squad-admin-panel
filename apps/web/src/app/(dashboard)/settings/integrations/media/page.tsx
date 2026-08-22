'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  GroupedList,
  GroupedRow,
  InlineBanner,
  PageHeader,
  Switch,
} from '@/components/ui';

interface MediaPublishingStatus {
  youtube_configured: boolean;
  telegram_configured: boolean;
  release_local_file: boolean;
}

const ENDPOINT = '/api/v1/integrations/media-publishing';

/**
 * Наличие учётных данных направления. Смысл несёт подпись, а не тон: «настроено»
 * и «не настроено» читаются одинаково при любом различении цветов (§5).
 */
function ConfiguredBadge({ configured }: { configured: boolean }) {
  return (
    <Badge tone={configured ? 'good' : 'neutral'}>
      {configured ? 'настроено' : 'не настроено'}
    </Badge>
  );
}

/**
 * "Публикация медиа" integration page (VIDEO-4, #160).
 *
 * Shows only whether each destination's credentials are present — the API
 * reports presence as a boolean and never returns a value, not even masked, so
 * there is nothing here to leak. The only editable setting is the
 * release-local-file switch; the credentials themselves are environment-only
 * and are read exclusively by `worker-media-publisher`.
 */
export default function MediaPublishingIntegrationPage() {
  const [status, setStatus] = useState<MediaPublishingStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(ENDPOINT, { credentials: 'include', cache: 'no-store' });
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus((await res.json()) as MediaPublishingStatus);
      setError(null);
    } catch (err) {
      setError(`Не удалось загрузить настройки публикации: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setReleaseLocalFile = useCallback(async (next: boolean) => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ release_local_file: next }),
      });
      if (!res.ok) {
        // Leave the previously stored value on screen — pretending the switch
        // moved would misrepresent what the worker will actually do.
        setSaveError('Не удалось сохранить настройку.');
        return;
      }
      setStatus((await res.json()) as MediaPublishingStatus);
    } catch {
      setSaveError('Не удалось сохранить настройку.');
    } finally {
      setSaving(false);
    }
  }, []);

  if (hidden) return null;

  return (
    <>
      <PageHeader
        title="Публикация медиа"
        subtitle="Куда уходят записи и что происходит с локальной копией после публикации."
      />

      {error && (
        <InlineBanner
          tone="crit"
          title={error}
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      )}

      <GroupedList
        title="Подключения"
        footnote="Учётные данные задаются только переменными окружения и читаются воркером media-publisher. Панель показывает лишь факт их наличия. Пока направление не настроено, публикации для него откладываются, а не помечаются ошибкой."
      >
        <GroupedRow
          label="YouTube"
          control={<ConfiguredBadge configured={status?.youtube_configured ?? false} />}
        />
        <GroupedRow
          label="Telegram"
          control={<ConfiguredBadge configured={status?.telegram_configured ?? false} />}
        />
      </GroupedList>

      <GroupedList
        title="Хранение"
        footnote="Файл освобождается только если опубликованы все направления, внешняя ссылка получена и на этот же файл не ссылается другая запись. По умолчанию выключено."
      >
        <GroupedRow
          label="Освобождать локальный файл после публикации"
          description="После успешной публикации локальная копия удаляется, а запись начинает ссылаться на внешний URL."
          control={
            <Switch
              label="Освобождать локальный файл после публикации"
              checked={status?.release_local_file ?? false}
              disabled={saving || !status}
              onChange={(next) => void setReleaseLocalFile(next)}
            />
          }
        />
      </GroupedList>

      {saveError && <InlineBanner tone="crit" title={saveError} />}
    </>
  );
}
