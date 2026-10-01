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
import { apiFetch, apiSend, describeHttpError } from '@/lib/api';
import type { LiveEvent, PlayerNote } from '@/lib/live-bus';
import {
  formatRelativeNote,
  type NotesPage,
  parseNotesPage,
  prependNote,
  removeNote,
  replaceNote,
} from '@/lib/player-notes';
import { useLiveSubscription } from '@/lib/use-live-bus';

interface Viewer {
  player_id: string;
  permissions: string[];
}

function readNotesPage(json: unknown): NotesPage {
  const page = parseNotesPage(json);
  if (!page) throw new Error('Некорректный ответ сервера');
  return page;
}

/** A failed mutation: what was attempted, and the server's answer. */
interface MutationError {
  title: string;
  message: string;
}

/**
 * «Заметки» player-card section: newest-first list with keyset paging, a
 * composer, and author-only edit / author-or-`role:edit` delete.
 *
 * Other moderators' changes arrive live — `note.created`, `note.updated` and
 * `note.deleted` (#449). Live notes and deletions that land while the first
 * page is in flight are remembered and merged into that page, so the answer
 * of a request sent before them cannot undo them.
 *
 * A failed load and a failed mutation are separate states (#448): only the
 * load banner offers «Повторить» (which reloads the list); a failed send,
 * edit or delete says which action failed and leaves the list as it is.
 */
export function NotesSection({ playerId, me }: { playerId: string; me: Viewer | null }) {
  const [notes, setNotes] = useState<PlayerNote[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<MutationError | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const idsRef = useRef<Set<string>>(new Set());
  const liveCreatedRef = useRef<PlayerNote[]>([]);
  const liveDeletedRef = useRef<Set<string>>(new Set());

  const canModerate = me?.permissions.includes('role:edit') ?? false;

  const applyPage = useCallback((response: NotesPage, append: boolean) => {
    const deleted = liveDeletedRef.current;
    const fetched = response.items.filter((note) => !deleted.has(note.id));
    const fetchedIds = new Set(fetched.map((note) => note.id));
    const liveOnly = append
      ? []
      : liveCreatedRef.current.filter((note) => !fetchedIds.has(note.id) && !deleted.has(note.id));
    setNotes((prev) => {
      const merged = append
        ? [...prev, ...fetched.filter((note) => !idsRef.current.has(note.id))]
        : [...liveOnly, ...fetched];
      idsRef.current = new Set(merged.map((note) => note.id));
      return merged;
    });
    if (!append) {
      const removedFromPage = response.items.length - fetched.length;
      setTotal(Math.max(0, response.total + liveOnly.length - removedFromPage));
    }
    setNextCursor(response.next_cursor);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    liveCreatedRef.current = [];
    liveDeletedRef.current = new Set();
    try {
      const body = await apiFetch<unknown>(`/api/v1/players/${encodeURIComponent(playerId)}/notes`);
      applyPage(readNotesPage(body), false);
    } catch (e) {
      setLoadError(describeHttpError(e));
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
      liveCreatedRef.current.push(note);
      if (idsRef.current.has(note.id)) return;
      idsRef.current.add(note.id);
      setNotes((prev) => prependNote(prev, note));
      setTotal((prev) => prev + 1);
    },
    [playerId],
  );
  useLiveSubscription('note.created', onIncoming);

  const onUpdated = useCallback(
    (event: Extract<LiveEvent, { type: 'note.updated' }>) => {
      if (event.data.player_id !== playerId) return;
      setNotes((prev) => replaceNote(prev, event.data.note));
    },
    [playerId],
  );
  useLiveSubscription('note.updated', onUpdated);

  const dropNote = useCallback((noteId: string) => {
    liveDeletedRef.current.add(noteId);
    if (!idsRef.current.has(noteId)) return;
    idsRef.current.delete(noteId);
    setNotes((prev) => removeNote(prev, noteId));
    setTotal((prev) => Math.max(0, prev - 1));
  }, []);

  const onDeleted = useCallback(
    (event: Extract<LiveEvent, { type: 'note.deleted' }>) => {
      if (event.data.player_id !== playerId) return;
      dropNote(event.data.note_id);
    },
    [playerId, dropNote],
  );
  useLiveSubscription('note.deleted', onDeleted);

  async function submit() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setMutationError(null);
    try {
      const created = await apiFetch<PlayerNote>(
        `/api/v1/players/${encodeURIComponent(playerId)}/notes`,
        { method: 'POST', json: { body } },
      );
      if (!idsRef.current.has(created.id)) {
        idsRef.current.add(created.id);
        setNotes((prev) => prependNote(prev, created));
        setTotal((prev) => prev + 1);
      }
      setDraft('');
    } catch (e) {
      setMutationError({ title: 'Не удалось отправить заметку', message: describeHttpError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    if (!nextCursor || busy) return;
    setBusy(true);
    try {
      const body = await apiFetch<unknown>(
        `/api/v1/players/${encodeURIComponent(playerId)}/notes?cursor=${encodeURIComponent(nextCursor)}`,
      );
      applyPage(readNotesPage(body), true);
    } catch (e) {
      setMutationError({
        title: 'Не удалось загрузить ещё заметки',
        message: describeHttpError(e),
      });
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

          {mutationError ? (
            <InlineBanner
              tone="crit"
              title={mutationError.title}
              description={mutationError.message}
            />
          ) : null}

          {loadError ? (
            <InlineBanner
              tone="crit"
              title="Не удалось загрузить заметки"
              description={loadError}
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
                    setMutationError(null);
                    setNotes((prev) => replaceNote(prev, updated));
                  }}
                  onRemoved={(noteId) => {
                    setMutationError(null);
                    dropNote(noteId);
                  }}
                  onError={setMutationError}
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
  onError: (error: MutationError) => void;
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
      const updated = await apiFetch<PlayerNote>(`/api/v1/notes/${note.id}`, {
        method: 'PATCH',
        json: { body },
      });
      onChanged(updated);
      setEditing(false);
    } catch (e) {
      onError({ title: 'Не удалось сохранить заметку', message: describeHttpError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      await apiSend(`/api/v1/notes/${note.id}`, { method: 'DELETE' });
      setConfirmOpen(false);
      onRemoved(note.id);
    } catch (e) {
      setConfirmOpen(false);
      onError({ title: 'Не удалось удалить заметку', message: describeHttpError(e) });
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
