'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { RoleColorDot } from '@/components/RoleColorDot';
import {
  AlertDialog,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  InlineBanner,
  Skeleton,
  Textarea,
} from '@/components/ui';
import type { LiveEvent, PlayerNote } from '@/lib/live-bus';
import { formatRelativeNote, prependNote, removeNote, replaceNote } from '@/lib/player-notes';
import { useLiveSubscription } from '@/lib/use-live-bus';

interface NotesResponse {
  items: PlayerNote[];
  next_cursor: string | null;
  total: number;
}

interface Viewer {
  player_id: string;
  permissions: string[];
}

export function NotesSection({ playerId, me }: { playerId: string; me: Viewer | null }) {
  const [notes, setNotes] = useState<PlayerNote[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const idsRef = useRef<Set<string>>(new Set());

  const canModerate = me?.permissions.includes('role:edit') ?? false;

  const applyPage = useCallback((response: NotesResponse, append: boolean) => {
    setNotes((prev) => {
      const merged = append ? [...prev, ...response.items] : response.items;
      idsRef.current = new Set(merged.map((note) => note.id));
      return merged;
    });
    setTotal(response.total);
    setNextCursor(response.next_cursor);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/players/${playerId}/notes`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyPage((await res.json()) as NotesResponse, false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [playerId, applyPage]);

  useEffect(() => {
    void load();
  }, [load]);

  const onIncoming = useCallback(
    (event: Extract<LiveEvent, { type: 'note.created' }>) => {
      if (event.data.player_id !== playerId) return;
      const note = event.data.note;
      if (idsRef.current.has(note.id)) return;
      idsRef.current.add(note.id);
      setNotes((prev) => prependNote(prev, note));
      setTotal((prev) => prev + 1);
    },
    [playerId],
  );
  useLiveSubscription('note.created', onIncoming);

  async function submit() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/players/${playerId}/notes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const created = (await res.json()) as PlayerNote;
      if (!idsRef.current.has(created.id)) {
        idsRef.current.add(created.id);
        setNotes((prev) => prependNote(prev, created));
        setTotal((prev) => prev + 1);
      }
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    if (!nextCursor || busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/v1/players/${playerId}/notes?cursor=${encodeURIComponent(nextCursor)}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyPage((await res.json()) as NotesResponse, true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    // biome-ignore lint/correctness/useUniqueElementIds: идентификатор — цель ссылки /all-players/{id}#notes из уведомлений, сгенерированный useId() её бы сломал
    <section id="notes" className="scroll-mt-6">
      <Card padding="none">
        <CardHeader title="Заметки" count={total} />
        <CardBody className="space-y-4">
          <div className="space-y-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKeyDown}
              rows={2}
              maxLength={2000}
              aria-label="Текст заметки"
              placeholder="Добавить заметку… (Enter — отправить, Shift+Enter — новая строка)"
            />
            <div className="flex justify-end">
              <Button
                variant="primary"
                onClick={() => void submit()}
                disabled={!draft.trim() || busy}
              >
                Отправить
              </Button>
            </div>
          </div>

          {error ? (
            <InlineBanner
              tone="crit"
              title="Не удалось загрузить заметки"
              description={error}
              action={
                <Button size="sm" onClick={() => void load()}>
                  Повторить
                </Button>
              }
            />
          ) : null}

          {loading ? (
            <Skeleton variant="block" count={3} label="Загрузка заметок" />
          ) : notes.length === 0 ? (
            <EmptyState
              title="Заметок нет"
              description="Здесь появятся заметки, которые оставят о нём модераторы."
            />
          ) : (
            <ul className="space-y-3">
              {notes.map((note) => (
                <NoteItem
                  key={note.id}
                  note={note}
                  canDelete={note.author.id === me?.player_id || canModerate}
                  canEdit={note.author.id === me?.player_id}
                  onChanged={(updated) => {
                    setNotes((prev) => replaceNote(prev, updated));
                  }}
                  onRemoved={(noteId) => {
                    idsRef.current.delete(noteId);
                    setNotes((prev) => removeNote(prev, noteId));
                    setTotal((prev) => Math.max(0, prev - 1));
                  }}
                  onError={setError}
                />
              ))}
            </ul>
          )}

          {nextCursor ? (
            <div className="flex justify-center">
              <Button size="sm" onClick={() => void loadMore()} disabled={busy}>
                Показать ещё
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>
    </section>
  );
}

function NoteItem({
  note,
  canEdit,
  canDelete,
  onChanged,
  onRemoved,
  onError,
}: {
  note: PlayerNote;
  canEdit: boolean;
  canDelete: boolean;
  onChanged: (note: PlayerNote) => void;
  onRemoved: (noteId: string) => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function saveEdit() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/notes/${note.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onChanged((await res.json()) as PlayerNote);
      setEditing(false);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/notes/${note.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setConfirmOpen(false);
      onRemoved(note.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-2 rounded-ctl border border-line p-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="inline-flex items-center gap-2">
          <RoleColorDot color={note.author.role_color ?? 'neutral'} size="sm" />
          <span className="font-medium text-ink">{note.author.name}</span>
          <span className="text-ink-3">{formatRelativeNote(note.created_at)}</span>
          {note.edited ? <span className="text-ink-3">(изменено)</span> : null}
        </span>
        {(canEdit || canDelete) && !editing ? (
          <span className="flex gap-2">
            {canEdit ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(note.body);
                  setEditing(true);
                }}
              >
                Изменить
              </Button>
            ) : null}
            {canDelete ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmOpen(true)}
              >
                Удалить
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
      {editing ? (
        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            maxLength={2000}
            aria-label="Текст заметки"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => void saveEdit()}
              disabled={!draft.trim()}
              loading={busy}
            >
              Сохранить
            </Button>
            <Button size="sm" onClick={() => setEditing(false)} disabled={busy}>
              Отмена
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap break-words text-[13px] text-ink">{note.body}</p>
      )}

      {/* Заметка удаляется безвозвратно — тон критический (§5). */}
      <AlertDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Удалить заметку"
        body="Заметка исчезнет у всех, кто видит карточку игрока. Отменить удаление нельзя."
        confirmLabel="Удалить заметку"
        cancelLabel="Отмена"
        tone="destructive"
        busy={busy}
        onConfirm={remove}
      />
    </li>
  );
}
