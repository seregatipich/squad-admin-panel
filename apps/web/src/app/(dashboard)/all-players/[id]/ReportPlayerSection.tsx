'use client';

import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import {
  Button,
  FieldRow,
  IconButton,
  InlineBanner,
  Modal,
  Select,
  Textarea,
  TextInput,
  TrashIcon,
} from '@/components/ui';
import {
  buildReportPayload,
  mapReportError,
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
 *
 * The server list is fetched when the modal first opens, not with the card
 * (#465); a failure there is shown in the modal with «Повторить» and never
 * hides the button. Evidence uploaded in this modal belongs to the report
 * being written: removing it, or closing the modal without sending, deletes
 * it from the media library again (#464). Rejections are shown in Russian
 * (#466).
 */
export function ReportPlayerSection({
  playerId,
  canViewServers,
}: {
  playerId: string;
  /** Whether the viewer holds `server:view`, which `GET /api/v1/servers` requires. */
  canViewServers: boolean;
}) {
  const [servers, setServers] = useState<ServerOption[] | null>(null);
  const [serversLoading, setServersLoading] = useState(false);
  const [serversError, setServersError] = useState<string | null>(null);
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

  if (!canViewServers) return null;

  async function loadServers() {
    setServersLoading(true);
    setServersError(null);
    try {
      const res = await fetch('/api/v1/servers', { credentials: 'include', cache: 'no-store' });
      if (res.status === 401 || res.status === 403) {
        throw new Error('Нет доступа к списку серверов');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ServersResponse;
      setServers(data.items);
      setServerId((current) => current || (data.items[0]?.id ?? ''));
    } catch (e) {
      setServersError((e as Error).message);
    } finally {
      setServersLoading(false);
    }
  }

  function openModal() {
    setServerId(servers?.[0]?.id ?? '');
    setBody('');
    setAttached([]);
    setEvidenceUrl('');
    setError(null);
    setSuccess(null);
    setModalOpen(true);
    if (servers === null) void loadServers();
  }

  /**
   * Deletes media uploaded for this report from the library. Best effort: a
   * failure leaves an orphaned file, which is no worse than before and must
   * not block closing the modal.
   */
  function discardMedia(ids: string[]) {
    for (const id of ids) {
      void fetch(`/api/v1/media/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
      }).catch(() => undefined);
    }
  }

  function closeWithoutSending() {
    discardMedia(attached.map((item) => item.id));
    setAttached([]);
    setModalOpen(false);
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
    discardMedia([id]);
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
        throw new Error(mapReportError(res.status, errBody.error));
      }
      setAttached([]);
      setModalOpen(false);
      setSuccess('Жалоба отправлена');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button size="sm" onClick={openModal}>
        Пожаловаться
      </Button>

      {success ? (
        <InlineBanner
          tone="good"
          title={success}
          action={
            <Link href="/reports" className="text-xs text-accent">
              Перейти к жалобам
            </Link>
          }
        />
      ) : null}

      <Modal
        open={modalOpen}
        onClose={closeWithoutSending}
        title="Пожаловаться на игрока"
        closeLabel="Закрыть"
        dismissible={!submitting}
        footer={
          <>
            <Button variant="secondary" onClick={closeWithoutSending} disabled={submitting}>
              Отмена
            </Button>
            <Button
              variant="primary"
              loading={submitting}
              disabled={!serverId || !body.trim()}
              onClick={() => void submit()}
            >
              Отправить жалобу
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {serversError ? (
            <InlineBanner
              tone="crit"
              title="Не удалось загрузить список серверов"
              description={serversError}
              action={
                <Button size="sm" loading={serversLoading} onClick={() => void loadServers()}>
                  Повторить
                </Button>
              }
            />
          ) : null}

          <FieldRow label="Сервер" htmlFor={serverSelectId}>
            <Select
              id={serverSelectId}
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
            >
              <option value="">Выберите сервер</option>
              {(servers ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name ?? s.slug ?? s.id.slice(0, 8)}
                </option>
              ))}
            </Select>
          </FieldRow>

          <FieldRow label="Текст жалобы" htmlFor={bodyTextareaId}>
            <Textarea
              id={bodyTextareaId}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              maxLength={REPORT_BODY_MAX}
              placeholder="Опишите нарушение…"
            />
          </FieldRow>

          <div className="space-y-2 rounded-ctl border border-line p-3">
            <p className="text-xs font-medium text-ink-2">Доказательства (необязательно)</p>

            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,video/webm,image/png,image/jpeg"
              disabled={uploading}
              aria-label="Файл доказательства"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadFile(file);
              }}
              className="block w-full text-xs text-ink-2"
            />

            <div className="flex gap-2">
              <TextInput
                id={urlInputId}
                type="text"
                value={evidenceUrl}
                onChange={(e) => setEvidenceUrl(e.target.value)}
                aria-label="Ссылка на доказательство"
                placeholder="Ссылка на доказательство"
                className="flex-1"
              />
              <Button onClick={() => void attachUrl()} disabled={uploading || !evidenceUrl.trim()}>
                Добавить
              </Button>
            </div>

            {attached.length > 0 ? (
              <ul className="space-y-1">
                {attached.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-2 text-xs text-ink-2"
                  >
                    <span className="truncate">{item.label}</span>
                    <IconButton
                      size="sm"
                      tone="destructive"
                      icon={<TrashIcon />}
                      label={`Убрать вложение ${item.label}`}
                      onClick={() => removeAttached(item.id)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {error ? (
            <InlineBanner tone="crit" title="Жалоба не отправлена" description={error} />
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
