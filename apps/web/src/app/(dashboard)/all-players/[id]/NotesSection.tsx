'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { RoleColorDot } from '@/components/RoleColorDot';
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
    // biome-ignore lint/correctness/useUniqueElementIds: stable anchor for /players/{id}#notes deep-links
    <section
      id="notes"
      className="scroll-mt-6 rounded border border-neutral-800 bg-neutral-950 p-4 space-y-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-widest text-neutral-400">
          Заметки
          <span className="ml-2 rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200 tabular-nums">
            {total}
          </span>
        </h2>
      </div>

      <div className="space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onComposerKeyDown}
          rows={2}
          maxLength={2000}
          placeholder="Добавить заметку… (Enter — отправить, Shift+Enter — новая строка)"
          className="w-full resize-y rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-600"
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!draft.trim() || busy}
            className="rounded bg-sky-600 px-4 py-1.5 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
          >
            Отправить
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          Ошибка: {error}
        </div>
      ) : null}

      {loading ? (
        <div className="text-sm text-neutral-500">Загрузка…</div>
      ) : notes.length === 0 ? (
        <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
          Нет заметок
        </div>
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
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={busy}
            className="rounded border border-neutral-800 px-3 py-1 text-xs hover:border-neutral-600 disabled:opacity-40"
          >
            Показать ещё
          </button>
        </div>
      ) : null}
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
    if (!confirm('Удалить заметку?')) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/notes/${note.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onRemoved(note.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded border border-neutral-900 bg-neutral-900/40 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="inline-flex items-center gap-2">
          <RoleColorDot color={note.author.role_color ?? 'neutral'} size="sm" />
          <span className="font-medium text-neutral-200">{note.author.name}</span>
          <span className="text-neutral-500">{formatRelativeNote(note.created_at)}</span>
          {note.edited ? <span className="text-neutral-600">(изменено)</span> : null}
        </span>
        {(canEdit || canDelete) && !editing ? (
          <span className="flex gap-2">
            {canEdit ? (
              <button
                type="button"
                onClick={() => {
                  setDraft(note.body);
                  setEditing(true);
                }}
                className="text-neutral-400 hover:text-neutral-200"
              >
                изменить
              </button>
            ) : null}
            {canDelete ? (
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy}
                className="text-red-400 hover:text-red-300 disabled:opacity-40"
              >
                удалить
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            maxLength={2000}
            className="w-full resize-y rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-600"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void saveEdit()}
              disabled={!draft.trim() || busy}
              className="rounded bg-sky-600 px-3 py-1 text-xs text-white hover:bg-sky-500 disabled:opacity-40"
            >
              Сохранить
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy}
              className="rounded border border-neutral-800 px-3 py-1 text-xs hover:border-neutral-600"
            >
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm text-neutral-100">{note.body}</p>
      )}
    </li>
  );
}
