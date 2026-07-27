'use client';

import { useCallback, useEffect, useId, useState } from 'react';

interface MediaPublishingStatus {
  youtube_configured: boolean;
  telegram_configured: boolean;
  release_local_file: boolean;
}

const ENDPOINT = '/api/v1/integrations/media-publishing';

function ConfiguredBadge({ configured }: { configured: boolean }) {
  return configured ? (
    <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[11px] text-emerald-300">
      настроено
    </span>
  ) : (
    <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-400">
      не настроено
    </span>
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
  const releaseToggleId = useId();
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
    <main className="space-y-4 p-6">
      <h1 className="text-sm uppercase tracking-widest text-neutral-300">Публикация медиа</h1>

      {error && (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Подключения</h2>
        <p className="text-xs text-neutral-500">
          Учётные данные задаются только переменными окружения и читаются воркером media-publisher.
          Панель показывает лишь факт их наличия. Пока направление не настроено, публикации для него
          откладываются, а не помечаются ошибкой.
        </p>
        <ul className="space-y-2 text-sm">
          <li className="flex items-center justify-between gap-2">
            <span className="text-neutral-300">YouTube</span>
            <ConfiguredBadge configured={status?.youtube_configured ?? false} />
          </li>
          <li className="flex items-center justify-between gap-2">
            <span className="text-neutral-300">Telegram</span>
            <ConfiguredBadge configured={status?.telegram_configured ?? false} />
          </li>
        </ul>
      </section>

      <section className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">Хранение</h2>
        <label
          htmlFor={releaseToggleId}
          className="flex items-start gap-2 text-sm text-neutral-300"
        >
          <input
            id={releaseToggleId}
            type="checkbox"
            className="mt-1"
            checked={status?.release_local_file ?? false}
            disabled={saving || !status}
            onChange={(event) => void setReleaseLocalFile(event.target.checked)}
          />
          <span>
            Освобождать локальный файл после публикации
            <span className="mt-1 block text-xs text-neutral-500">
              После успешной публикации локальная копия удаляется, а запись начинает ссылаться на
              внешний URL. Файл освобождается только если опубликованы все направления, внешняя
              ссылка получена и на этот же файл не ссылается другая запись. По умолчанию выключено.
            </span>
          </span>
        </label>
        {saveError && (
          <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
            {saveError}
          </div>
        )}
      </section>
    </main>
  );
}
