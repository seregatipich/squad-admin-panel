'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  InlineBanner,
  PageContainer,
  PageHeader,
  Skeleton,
  StatusBadge,
  type StatusState,
  Textarea,
} from '@/components/ui';
import type { IssueComment, IssueLabel, IssueState, IssueView } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { appendComment, authorLabel, BODY_MAX, formatDateTime, STATE_LABELS } from '../helpers';
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

/** См. `IssuesBrowser`: тон дублирует подпись состояния, а не заменяет её (§5). */
const STATE_STATE: Record<IssueState, StatusState> = {
  open: 'good',
  in_progress: 'warn',
  closed: 'idle',
};

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

  // Заголовок страницы и возврат к списку остаются на всех ветках: без них
  // экран ошибки и экран загрузки теряют единственный `h1` и путь назад.
  if (error) {
    return (
      <PageContainer width="reading">
        <PageHeader title="Тикет" backHref="/issues" backLabel="К списку тикетов" />
        <InlineBanner
          tone="crit"
          title="Не удалось загрузить тикет"
          description={error}
          action={
            <Button size="sm" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      </PageContainer>
    );
  }

  if (!issue) {
    return (
      <PageContainer width="reading">
        <PageHeader title="Тикет" backHref="/issues" backLabel="К списку тикетов" />
        <Skeleton variant="card" count={2} label="Загрузка тикета" />
      </PageContainer>
    );
  }

  const canManage = me?.can_manage_issues ?? false;

  return (
    <PageContainer width="reading">
      <PageHeader
        title={issue.title}
        backHref="/issues"
        backLabel="К списку тикетов"
        status={<StatusBadge state={STATE_STATE[issue.state]} label={STATE_LABELS[issue.state]} />}
        meta={
          <>
            <span className="font-mono">#{issue.number}</span>
            <span>
              Автор:{' '}
              <Link
                href={`/all-players/${issue.author_player_id}`}
                className="text-accent no-underline hover:brightness-110"
              >
                {authorLabel(issue.author, issue.author_player_id)}
              </Link>
            </span>
            <span>
              Исполнитель:{' '}
              {issue.assignee ? (
                <Link
                  href={`/all-players/${issue.assignee.id}`}
                  className="text-accent no-underline hover:brightness-110"
                >
                  {issue.assignee.name}
                </Link>
              ) : (
                'не назначен'
              )}
            </span>
            <span>Создан: {formatDateTime(issue.created_at)}</span>
            <span>Обновлён: {formatDateTime(issue.updated_at)}</span>
          </>
        }
      />

      <Card as="article">
        <div className="space-y-3">
          {issue.labels.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {issue.labels.map((label) => (
                <IssueLabelChip key={label.id} label={label} />
              ))}
            </div>
          ) : null}
          <p className="whitespace-pre-wrap break-words text-[13px] text-ink">{issue.body}</p>
        </div>
      </Card>

      {canManage ? (
        <Card padding="none" as="section">
          <CardHeader title="Управление" />
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {issue.state !== 'closed' ? (
                <Button disabled={busy} onClick={() => void patch({ state: 'closed' })}>
                  Закрыть
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void patch({ state: 'open' })}
                >
                  Переоткрыть
                </Button>
              )}
              {issue.state === 'open' ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void patch({ state: 'in_progress', assignee_player_id: me?.player_id })
                  }
                >
                  Взять в работу
                </Button>
              ) : null}
              {issue.assignee ? (
                <Button disabled={busy} onClick={() => void patch({ assignee_player_id: null })}>
                  Снять исполнителя
                </Button>
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
              <InlineBanner tone="crit" title="Действие не выполнено" description={actionError} />
            ) : null}
          </CardBody>
        </Card>
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
    </PageContainer>
  );
}

/**
 * Метка тикета: цвет приходит из базы, поэтому `Badge` с его перечисленными
 * тонами здесь не подходит — форма и кегль всё равно повторяют пилюлю (§1).
 */
function IssueLabelChip({ label }: { label: IssueLabel }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-px text-2xs font-medium text-ink"
      style={{ backgroundColor: label.color }}
    >
      {label.name}
    </span>
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
    <Card padding="none" as="section">
      <CardHeader title="Комментарии" count={comments.length} />

      {comments.length === 0 ? (
        <EmptyState
          title="Комментариев пока нет"
          description="Опишите, что выяснилось по тикету, — обсуждение останется в истории."
        />
      ) : (
        <ul className="divide-y divide-line">
          {comments.map((comment) => (
            <li key={comment.id} className="space-y-1 px-4 py-3">
              <div className="flex items-center gap-2 text-xs">
                <Link
                  href={`/all-players/${comment.author_player_id}`}
                  className="font-medium text-ink no-underline hover:text-accent"
                >
                  {authorLabel(comment.author, comment.author_player_id)}
                </Link>
                <span className="text-ink-3">{formatDateTime(comment.created_at)}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-[13px] text-ink-2">
                {comment.body}
              </p>
            </li>
          ))}
        </ul>
      )}

      <CardBody className="space-y-2 border-t border-line">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          maxLength={BODY_MAX}
          aria-label="Новый комментарий"
          placeholder="Оставить комментарий… (Enter — отправить, Shift+Enter — новая строка)"
        />
        {error ? (
          <InlineBanner tone="crit" title="Комментарий не отправлен" description={error} />
        ) : null}
      </CardBody>

      <CardFooter>
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={!draft.trim()}
          loading={busy}
        >
          Отправить
        </Button>
      </CardFooter>
    </Card>
  );
}
