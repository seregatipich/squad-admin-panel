'use client';

import { useCallback, useState } from 'react';
import {
  Badge,
  Button,
  GroupedList,
  GroupedRow,
  InlineBanner,
  PageHeader,
  Switch,
} from '@/components/ui';
import { ApiError, apiFetch } from '@/lib/api';
import { useApiResource } from '@/lib/use-polled-resource';

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
  const {
    data: status,
    error: loadError,
    errorMessage: loadErrorMessage,
    setData: setStatus,
  } = useApiResource<MediaPublishingStatus>(ENDPOINT);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const hidden =
    loadError instanceof ApiError && (loadError.status === 401 || loadError.status === 403);
  const error =
    loadError && !hidden ? `Не удалось загрузить настройки публикации: ${loadErrorMessage}` : null;

  const setReleaseLocalFile = useCallback(
    async (next: boolean) => {
      setSaving(true);
      setSaveError(null);
      try {
        setStatus(
          await apiFetch<MediaPublishingStatus>(ENDPOINT, {
            method: 'PATCH',
            json: { release_local_file: next },
          }),
        );
      } catch {
        // Leave the previously stored value on screen — pretending the switch
        // moved would misrepresent what the worker will actually do.
        setSaveError('Не удалось сохранить настройку.');
      } finally {
        setSaving(false);
      }
    },
    [setStatus],
  );

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
