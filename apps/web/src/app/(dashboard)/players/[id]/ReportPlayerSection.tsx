'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import {
  buildReportPayload,
  mapUploadError,
  REPORT_BODY_MAX,
  REPORT_EVIDENCE_MAX,
  validateEvidenceUrl,
} from './report-player';

interface ServerOption {
  id: string;
  display_name: string | null;
  slug: string | null;
}

interface ServersResponse {
  items: ServerOption[];
}

interface AttachedEvidence {
  id: string;
  label: string;
}

interface MediaResponse {
  id: string;
  original_filename: string;
  external_url: string | null;
  title: string | null;
}

function evidenceLabelFromMedia(media: MediaResponse): string {
  return media.title ?? media.external_url ?? media.original_filename;
}

/**
 * «Пожаловаться» — panel-side report submission (REPORT-4). Renders a button
 * on the player card that opens a modal to file a `player_reports` row with
 * `source='ui'`, optionally attaching evidence (uploaded files or external
 * links) reusing the MOD-3 media library. Hidden entirely for viewers who
 * lack the `server:view` permission needed to populate the server select
 * (POST /api/v1/reports itself only requires `panel_access`).
 */
export function ReportPlayerSection({ playerId }: { playerId: string }) {
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [hidden, setHidden] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [serverId, setServerId] = useState('');
  const [body, setBody] = useState('');
  const [attached, setAttached] = useState<AttachedEvidence[]>([]);
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const serverSelectId = useId();
  const bodyTextareaId = useId();
  const urlInputId = useId();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' })
      .then((res) => {
        if (res.status === 401 || res.status === 403) {
          setHidden(true);
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<ServersResponse>;
      })
      .then((data) => {
        if (cancelled || !data) return;
        setServers(data.items);
      })
      .catch(() => {
        if (!cancelled) setHidden(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (hidden) return null;

  function openModal() {
    setServerId(servers[0]?.id ?? '');
    setBody('');
    setAttached([]);
    setEvidenceUrl('');
    setError(null);
    setSuccess(null);
    setModalOpen(true);
  }

  async function uploadFile(file: File) {
    if (attached.length >= REPORT_EVIDENCE_MAX) {
      setError(`Можно приложить не более ${REPORT_EVIDENCE_MAX} вложений`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/v1/media', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(mapUploadError(res.status, errBody.error));
      }
      const media = (await res.json()) as MediaResponse;
      setAttached((prev) => [...prev, { id: media.id, label: evidenceLabelFromMedia(media) }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function attachUrl() {
    if (attached.length >= REPORT_EVIDENCE_MAX) {
      setError(`Можно приложить не более ${REPORT_EVIDENCE_MAX} вложений`);
      return;
    }
    const validation = validateEvidenceUrl(evidenceUrl);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/media/link', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ external_url: evidenceUrl.trim() }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(mapUploadError(res.status, errBody.error));
      }
      const media = (await res.json()) as MediaResponse;
      setAttached((prev) => [...prev, { id: media.id, label: evidenceLabelFromMedia(media) }]);
      setEvidenceUrl('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function removeAttached(id: string) {
    setAttached((prev) => prev.filter((item) => item.id !== id));
  }

  async function submit() {
    const trimmedBody = body.trim();
    if (!serverId || !trimmedBody || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = buildReportPayload(
        serverId,
        playerId,
        trimmedBody,
        attached.map((item) => item.id),
      );
      const res = await fetch('/api/v1/reports', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      setModalOpen(false);
      setSuccess('Жалоба отправлена');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={openModal}
        className="rounded border border-amber-900 px-3 py-1.5 text-xs text-amber-300 hover:border-amber-700"
      >
        Пожаловаться
      </button>

      {success ? (
        <p className="mt-2 text-xs text-emerald-300">
          {success}{' '}
          <Link href="/reports" className="text-sky-400 hover:text-sky-300">
            Перейти к жалобам →
          </Link>
        </p>
      ) : null}

      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
          <div className="mt-16 w-full max-w-lg rounded border border-neutral-800 bg-neutral-950 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Пожаловаться на игрока</h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-sm text-neutral-400 hover:text-neutral-200"
              >
                Закрыть
              </button>
            </div>

            <div>
              <label htmlFor={serverSelectId} className="mb-1 block text-xs text-neutral-500">
                Сервер
              </label>
              <select
                id={serverSelectId}
                value={serverId}
                onChange={(e) => setServerId(e.target.value)}
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              >
                <option value="">Выберите сервер</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name ?? s.slug ?? s.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor={bodyTextareaId} className="mb-1 block text-xs text-neutral-500">
                Текст жалобы
              </label>
              <textarea
                id={bodyTextareaId}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                maxLength={REPORT_BODY_MAX}
                placeholder="Опишите нарушение…"
                className="w-full resize-y rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
              />
            </div>

            <div className="space-y-2 rounded border border-neutral-800 bg-neutral-900 p-3">
              <p className="text-xs text-neutral-500">Доказательства (необязательно)</p>

              <input
                ref={fileInputRef}
                type="file"
                accept="video/mp4,video/webm,image/png,image/jpeg"
                disabled={uploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadFile(file);
                }}
                className="block w-full text-xs text-neutral-400"
              />

              <div className="flex gap-2">
                <input
                  id={urlInputId}
                  type="text"
                  value={evidenceUrl}
                  onChange={(e) => setEvidenceUrl(e.target.value)}
                  placeholder="Ссылка на доказательство"
                  className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm focus:border-neutral-600 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void attachUrl()}
                  disabled={uploading || !evidenceUrl.trim()}
                  className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
                >
                  Добавить
                </button>
              </div>

              {attached.length > 0 ? (
                <ul className="space-y-1">
                  {attached.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center justify-between gap-2 text-xs text-neutral-300"
                    >
                      <span className="truncate">{item.label}</span>
                      <button
                        type="button"
                        onClick={() => removeAttached(item.id)}
                        className="text-red-400 hover:text-red-300"
                      >
                        убрать
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            {error ? <p className="text-xs text-red-400">{error}</p> : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded border border-neutral-800 px-4 py-1.5 text-sm text-neutral-300 hover:border-neutral-600"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={submitting || !serverId || !body.trim()}
                className="rounded border border-emerald-900 px-4 py-1.5 text-sm text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
              >
                {submitting ? 'Отправка…' : 'Отправить жалобу'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
