'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { InlineBanner, PageContainer, PageHeader } from '@/components/ui';
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
 * Выбор файла — это `<label>` вокруг настоящего `<input type="file">`, а не
 * кнопка: диалог файлов открывает сам браузер, и подменить его кнопкой значит
 * потерять клавиатурный путь. Поэтому размеры кнопки (§6) выписаны здесь
 * вручную — примитив `Button` рендерит `<button>` и сюда не подходит.
 */
const FILE_LABEL_CLASS =
  'mt-4 inline-flex h-8 cursor-pointer items-center justify-center rounded-ctl bg-accent px-3 text-xs font-medium text-bg transition-colors duration-150 hover:brightness-110';

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
    <PageContainer width="reading">
      <PageHeader
        title="Загрузка доказательства"
        subtitle="Эта ссылка одноразовая и действует ограниченное время. Вход в панель не требуется."
      />

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
        className={`rounded-card border border-dashed p-8 text-center transition-colors duration-150 ${
          dragging ? 'border-accent bg-accent-dim' : 'border-line bg-surface'
        }`}
      >
        <p className="text-[13px] text-ink">Перетащите файл сюда или выберите его вручную.</p>
        <p className="mt-1 text-xs text-ink-3">Поддерживаются MP4, WebM, PNG и JPEG.</p>
        <label className={FILE_LABEL_CLASS}>
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
            className="h-1 w-full overflow-hidden rounded-full bg-raised"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-150"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <p data-testid="upload-progress-text" className="text-xs text-ink-3">
            {filename ? `${filename} — ` : ''}
            {progress.loaded} из {progress.total} ({progress.percent}%), {progress.speed}
          </p>
        </div>
      )}

      {phase === 'done' && (
        <InlineBanner
          tone="good"
          title="Файл загружен."
          description="Спасибо — администратор увидит его в деле."
        />
      )}

      {phase === 'error' && error && <InlineBanner tone="crit" title={error} />}
    </PageContainer>
  );
}
