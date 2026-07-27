'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ACCEPTED_UPLOAD_TYPES,
  computeProgress,
  isAcceptedUploadType,
  type UploadProgress,
  uploadErrorMessage,
} from './upload-progress';

type Phase = 'idle' | 'uploading' | 'done' | 'error';

const IDLE_PROGRESS: UploadProgress = {
  percent: 0,
  loaded: '0.0 МБ',
  total: '0.0 МБ',
  speed: '—',
};

/**
 * Public, session-less upload page for a one-time link (VIDEO-3, #159). The
 * token in the URL is the only credential: the page never reads a cookie,
 * never calls a panel endpoint besides `POST /api/v1/public/media`, and shows
 * the uploader nothing about the panel beyond success or failure.
 *
 * Uses `XMLHttpRequest` rather than `fetch` purely because it is the only
 * browser API that reports upload progress, which the transferred-megabytes
 * and speed readout needs.
 */
export function UploadClient({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<UploadProgress>(IDLE_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [filename, setFilename] = useState<string | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  useEffect(() => {
    return () => {
      xhrRef.current?.abort();
      xhrRef.current = null;
    };
  }, []);

  const startUpload = useCallback(
    (file: File) => {
      if (!isAcceptedUploadType(file.type)) {
        setPhase('error');
        setError(uploadErrorMessage(415));
        return;
      }

      setFilename(file.name);
      setPhase('uploading');
      setError(null);
      setProgress(IDLE_PROGRESS);

      const startedAt = Date.now();
      const body = new FormData();
      body.append('file', file);

      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      xhr.upload.onprogress = (tick: { loaded: number; total: number }) => {
        setProgress(computeProgress(tick.loaded, tick.total, Date.now() - startedAt));
      };
      xhr.onload = () => {
        xhrRef.current = null;
        if (xhr.status === 201) {
          setPhase('done');
          return;
        }
        setPhase('error');
        setError(uploadErrorMessage(xhr.status));
      };
      xhr.onerror = () => {
        xhrRef.current = null;
        setPhase('error');
        setError('Сеть недоступна — загрузка не завершилась. Попробуйте ещё раз.');
      };
      xhr.open('POST', `/api/v1/public/media?token=${encodeURIComponent(token)}`);
      xhr.send(body);
    },
    [token],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) startUpload(file);
    },
    [startUpload],
  );

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold text-neutral-100">Загрузка доказательства</h1>
        <p className="text-sm text-neutral-400">
          Эта ссылка одноразовая и действует ограниченное время. Вход в панель не требуется.
        </p>
      </header>

      {/* A labelled region rather than a bare div: drag-and-drop is inherently
          pointer-only, so the region is announced and the keyboard path is the
          real file input it wraps. */}
      <section
        aria-label="Зона загрузки файла"
        data-testid="upload-dropzone"
        data-dragging={dragging ? 'true' : 'false'}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded border border-dashed p-8 text-center transition-colors ${
          dragging ? 'border-sky-500 bg-sky-950/30' : 'border-neutral-800 bg-neutral-900/40'
        }`}
      >
        <p className="text-sm text-neutral-300">Перетащите файл сюда или выберите его вручную.</p>
        <p className="mt-1 text-xs text-neutral-500">Поддерживаются MP4, WebM, PNG и JPEG.</p>
        <label className="mt-4 inline-block cursor-pointer rounded bg-sky-700 px-3 py-1.5 text-sm text-neutral-100 hover:bg-sky-600">
          Выбрать файл
          <input
            data-testid="upload-input"
            type="file"
            className="hidden"
            accept={ACCEPTED_UPLOAD_TYPES.join(',')}
            disabled={phase === 'uploading'}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) startUpload(file);
            }}
          />
        </label>
      </section>

      {phase === 'uploading' && (
        <div className="space-y-2">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
            aria-label="Прогресс загрузки"
            className="h-2 w-full overflow-hidden rounded bg-neutral-800"
          >
            <div className="h-full bg-sky-500" style={{ width: `${progress.percent}%` }} />
          </div>
          <p data-testid="upload-progress-text" className="text-xs text-neutral-400">
            {filename ? `${filename} — ` : ''}
            {progress.loaded} из {progress.total} ({progress.percent}%), {progress.speed}
          </p>
        </div>
      )}

      {phase === 'done' && (
        <output className="block rounded border border-emerald-900 bg-emerald-950 p-3 text-sm text-emerald-200">
          Файл загружен. Спасибо — администратор увидит его в деле.
        </output>
      )}

      {phase === 'error' && error && (
        <div
          role="alert"
          className="rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200"
        >
          {error}
        </div>
      )}
    </div>
  );
}
