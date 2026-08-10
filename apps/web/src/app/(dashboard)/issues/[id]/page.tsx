'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import type { IssueComment, IssueView } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import {
  appendComment,
  authorLabel,
  BODY_MAX,
  formatDateTime,
  STATE_BADGE_CLASSES,
  STATE_LABELS,
} from '../helpers';
import { type PickedPlayer, PlayerSearchSelect } from '../PlayerSearchSelect';
import { IssueLinksBlock } from './IssueLinksBlock';
import type { IssueLinkView } from './issue-links';

interface IssueDetail extends IssueView {
  comments: IssueComment[];
  links: IssueLinkView[];
}

interface Me {
  player_id: string;
  permissions: string[];
  can_manage_issues: boolean;
}

export default function IssueTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const commentIds = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/v1/issues/${id}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as IssueDetail;
      commentIds.current = new Set(data.comments.map((comment) => comment.id));
      setIssue(data);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
    fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setMe(j as Me | null))
      .catch(() => {});
  }, [load]);

  const onUpdated = useCallback(
    (event: { data: { issue: IssueView } }) => {
      if (event.data.issue.id !== id) return;
      setIssue((prev) => (prev ? { ...prev, ...event.data.issue } : prev));
    },
    [id],
  );
  useLiveSubscription('issue.updated', onUpdated);

  const onComment = useCallback(
    (event: { data: { issue_id: string; comment: IssueComment } }) => {
      if (event.data.issue_id !== id) return;
      const comment = event.data.comment;
      if (commentIds.current.has(comment.id)) return;
      commentIds.current.add(comment.id);
      setIssue((prev) =>
        prev ? { ...prev, comments: appendComment(prev.comments, comment) } : prev,
      );
    },
    [id],
  );
  useLiveSubscription('issue.comment.created', onComment);

  const patch = useCallback(
    async (payload: Record<string, unknown>) => {
      setBusy(true);
      setActionError(null);
      try {
        const res = await fetch(`/api/v1/issues/${id}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          const detail =
            typeof errBody.required === 'string' ? ` (нужно право ${errBody.required})` : '';
          throw new Error(`Не удалось выполнить действие: ${errBody.error ?? res.status}${detail}`);
        }
        const updated = (await res.json()) as IssueView;
        setIssue((prev) => (prev ? { ...prev, ...updated } : prev));
      } catch (e) {
        setActionError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  if (error) {
    return (
      <div>
        <Link href="/issues" className="text-sky-400 text-xs">
          ← тикеты
        </Link>
        <div className="mt-3 rounded border border-red-900 bg-red-950 p-3 text-sm text-red-200">
          Ошибка: {error}
        </div>
      </div>
    );
  }
  if (!issue) return <div className="text-neutral-500">Загрузка…</div>;

  const canManage = me?.can_manage_issues ?? false;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Link href="/issues" className="text-sky-400 hover:text-sky-300 text-xs font-mono">
          ← тикеты
        </Link>
        <span className="font-mono text-sm text-neutral-500">#{issue.number}</span>
        <h1 className="text-2xl font-semibold">{issue.title}</h1>
      </div>

      <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className={`rounded px-2 py-0.5 ${STATE_BADGE_CLASSES[issue.state]}`}>
            {STATE_LABELS[issue.state]}
          </span>
          <span className="text-neutral-500">
            Автор:{' '}
            <Link
              href={`/all-players/${issue.author_player_id}`}
              className="text-sky-400 hover:text-sky-300"
            >
              {authorLabel(issue.author, issue.author_player_id)}
            </Link>
          </span>
          <span className="text-neutral-500">
            Исполнитель:{' '}
            {issue.assignee ? (
              <Link
                href={`/all-players/${issue.assignee.id}`}
                className="text-sky-400 hover:text-sky-300"
              >
                {issue.assignee.name}
              </Link>
            ) : (
              <span className="text-neutral-600">не назначен</span>
            )}
          </span>
          <span className="text-neutral-600">Создан: {formatDateTime(issue.created_at)}</span>
          <span className="text-neutral-600">Обновлён: {formatDateTime(issue.updated_at)}</span>
        </div>

        {issue.labels.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {issue.labels.map((label) => (
              <span
                key={label.id}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium text-neutral-100"
                style={{ backgroundColor: label.color }}
              >
                {label.name}
              </span>
            ))}
          </div>
        ) : null}

        <p className="whitespace-pre-wrap break-words text-sm text-neutral-100">{issue.body}</p>
      </section>

      {canManage ? (
        <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-3">
          <h2 className="text-xs uppercase tracking-widest text-neutral-400">Управление</h2>
          <div className="flex flex-wrap items-center gap-2">
            {issue.state !== 'closed' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void patch({ state: 'closed' })}
                className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:border-neutral-500 disabled:opacity-40"
              >
                Закрыть
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void patch({ state: 'open' })}
                className="rounded border border-emerald-900 px-3 py-1 text-xs text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
              >
                Переоткрыть
              </button>
            )}
            {issue.state === 'open' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void patch({ state: 'in_progress', assignee_player_id: me?.player_id })
                }
                className="rounded border border-amber-900 px-3 py-1 text-xs text-amber-300 hover:border-amber-700 disabled:opacity-40"
              >
                Взять в работу
              </button>
            ) : null}
            {issue.assignee ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void patch({ assignee_player_id: null })}
                className="rounded border border-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-600 disabled:opacity-40"
              >
                Снять исполнителя
              </button>
            ) : null}
          </div>
          <div className="w-64">
            <PlayerSearchSelect
              placeholder="Назначить исполнителя"
              disabled={busy}
              onSelect={(player: PickedPlayer) => void patch({ assignee_player_id: player.id })}
            />
          </div>
          {actionError ? (
            <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
              {actionError}
            </div>
          ) : null}
        </section>
      ) : null}

      <IssueLinksBlock
        issueId={id}
        links={issue.links ?? []}
        viewer={me ? { player_id: me.player_id, can_manage_issues: canManage } : null}
        onChanged={() => void load()}
      />

      <CommentFeed
        issueId={id}
        comments={issue.comments}
        onLocalAppend={(comment) => {
          if (commentIds.current.has(comment.id)) return;
          commentIds.current.add(comment.id);
          setIssue((prev) =>
            prev ? { ...prev, comments: appendComment(prev.comments, comment) } : prev,
          );
        }}
      />
    </div>
  );
}

function CommentFeed({
  issueId,
  comments,
  onLocalAppend,
}: {
  issueId: string;
  comments: IssueComment[];
  onLocalAppend: (comment: IssueComment) => void;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/issues/${issueId}/comments`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onLocalAppend((await res.json()) as IssueComment);
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950 p-4 space-y-4">
      <h2 className="text-xs uppercase tracking-widest text-neutral-400">
        Комментарии
        <span className="ml-2 rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200 tabular-nums">
          {comments.length}
        </span>
      </h2>

      {comments.length === 0 ? (
        <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
          Комментариев пока нет.
        </div>
      ) : (
        <ul className="space-y-3">
          {comments.map((comment) => (
            <li
              key={comment.id}
              className="rounded border border-neutral-900 bg-neutral-900/40 p-3 space-y-1"
            >
              <div className="flex items-center gap-2 text-xs">
                <Link
                  href={`/all-players/${comment.author_player_id}`}
                  className="font-medium text-neutral-200 hover:text-neutral-100"
                >
                  {authorLabel(comment.author, comment.author_player_id)}
                </Link>
                <span className="text-neutral-500">{formatDateTime(comment.created_at)}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm text-neutral-100">
                {comment.body}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          maxLength={BODY_MAX}
          placeholder="Оставить комментарий… (Enter — отправить, Shift+Enter — новая строка)"
          className="w-full resize-y rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-600"
        />
        {error ? (
          <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
            {error}
          </div>
        ) : null}
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
    </section>
  );
}
