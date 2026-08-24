'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardHeader,
  GroupedList,
  GroupedRow,
  InlineBanner,
  PageHeader,
  Skeleton,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from '@/components/ui';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { AccountIdentity } from './AccountIdentity';
import {
  type AccountNames,
  describeDevice,
  formatDate,
  formatPermissionCount,
  formatRelative,
} from './helpers';
import { isCurrentSessionRevoked, type SessionRevokedEvent } from './sessionEvents';

const POLL_MS = 30_000;

interface Me {
  steam_id64: string | null;
  permissions: string[];
}

interface ActiveSession {
  id: string;
  ip: string | null;
  user_agent: string | null;
  last_activity_at: string;
  expires_at: string;
  current: boolean;
}

/** Какую сессию оператор попросил завершить: одну конкретную или все сразу. */
type PendingRevoke = { kind: 'one'; id: string } | { kind: 'all' };

export default function AccountSettings() {
  const [me, setMe] = useState<Me | null>(null);
  const [names, setNames] = useState<AccountNames | null>(null);
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<PendingRevoke | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const sessionsRef = useRef<ActiveSession[]>([]);
  sessionsRef.current = sessions;

  const onSessionRevoked = useCallback((event: SessionRevokedEvent) => {
    const currentSession = sessionsRef.current.find((s) => s.current);
    if (isCurrentSessionRevoked(event, currentSession?.id ?? null)) {
      window.location.href = '/login';
      return;
    }
    setSessions((prev) => prev.filter((s) => s.id !== event.data.session_id));
  }, []);
  useLiveSubscription('session.revoked', onSessionRevoked);

  const load = useCallback(async () => {
    try {
      const [meRes, sessRes, namesRes] = await Promise.all([
        fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/v1/me/sessions', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/v1/me/names', { credentials: 'include', cache: 'no-store' }),
      ]);
      if (!meRes.ok) throw new Error(`HTTP ${meRes.status}`);
      if (!sessRes.ok) throw new Error(`HTTP ${sessRes.status}`);
      if (!namesRes.ok) throw new Error(`HTTP ${namesRes.status}`);
      setMe((await meRes.json()) as Me);
      setSessions((await sessRes.json()) as ActiveSession[]);
      setNames((await namesRes.json()) as AccountNames);
      // Снимается только сообщение об ошибке: удачный опрос действительно
      // отменяет её, а подтверждение «Сессия завершена» оператор должен
      // успеть прочитать, и опрос раз в полминуты не имеет права его стереть.
      setMsg((prev) => (prev?.kind === 'err' ? null : prev));
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function revokeOne(id: string) {
    setBusyId(id);
    setMsg(null);
    try {
      const r = await fetch(`/api/v1/me/sessions/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setMsg({ kind: 'ok', text: 'Сессия завершена.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusyId(null);
      setPendingRevoke(null);
    }
  }

  async function revokeAll() {
    setRevokingAll(true);
    setMsg(null);
    try {
      const r = await fetch('/api/v1/me/sessions', {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      window.location.href = '/login';
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
      setRevokingAll(false);
      setPendingRevoke(null);
    }
  }

  const revokeBusy = pendingRevoke?.kind === 'all' ? revokingAll : busyId !== null;

  return (
    <>
      {/* Ник стоит в `actions`, у правого края строки заголовка: слева на этой
          странице всего одно слово, и оператор, у которого открыто несколько
          панелей, по нему не поймёт, под каким аккаунтом смотрит. */}
      <PageHeader title="Аккаунт" actions={<AccountIdentity names={names} />} />

      {msg ? (
        <InlineBanner
          tone={msg.kind === 'ok' ? 'good' : 'crit'}
          title={msg.kind === 'ok' ? msg.text : 'Не удалось выполнить запрос'}
          description={msg.kind === 'ok' ? undefined : msg.text}
          action={
            msg.kind === 'err' ? (
              <Button size="sm" onClick={() => void load()}>
                Повторить
              </Button>
            ) : undefined
          }
          onDismiss={() => setMsg(null)}
          dismissLabel="Скрыть сообщение"
        />
      ) : null}

      {me === null ? (
        <Skeleton variant="card" count={2} label="Загрузка профиля" />
      ) : (
        <GroupedList title="Профиль">
          <GroupedRow
            label="SteamID64"
            control={<span className="font-mono text-xs text-ink-2">{me.steam_id64 ?? '—'}</span>}
          />
          <GroupedRow
            label="Права"
            description="Набор ключей, которые даёт выданная вам роль."
            control={
              <span className="text-xs tabular-nums text-ink-2">
                {formatPermissionCount(me.permissions.length)}
              </span>
            }
          />
        </GroupedList>
      )}

      <Card padding="none">
        <CardHeader
          title="Активные сессии"
          count={sessions.length > 0 ? sessions.length : undefined}
          description="Устройства, с которых сейчас открыта панель."
          actions={
            /* «Завершить все» разлогинивает устройства, но ничего не разрушает
               безвозвратно — войти можно снова, поэтому кнопка вторичная (§5). */
            <Button
              disabled={revokingAll || sessions.length <= 1}
              onClick={() => setPendingRevoke({ kind: 'all' })}
            >
              Завершить все
            </Button>
          }
        />
        {me === null ? (
          <div className="p-3">
            <SkeletonTable rows={3} cols={5} label="Загрузка списка сессий" />
          </div>
        ) : (
          <Table ariaLabel="Активные сессии">
            <TableHead>
              <tr>
                <Th>IP</Th>
                <Th>Устройство</Th>
                <Th>Последнее действие</Th>
                <Th>Истекает</Th>
                <Th align="right" width="9rem">
                  Действие
                </Th>
              </tr>
            </TableHead>
            <TableBody>
              {sessions.map((s) => (
                <TableRow key={s.id} interactive>
                  <Td className="font-mono text-xs">{s.ip ?? '—'}</Td>
                  <Td className="text-xs text-ink-3">{describeDevice(s.user_agent)}</Td>
                  <Td className="text-xs text-ink-3">{formatDate(s.last_activity_at)}</Td>
                  <Td className="text-xs text-ink-3">
                    {formatDate(s.expires_at)}{' '}
                    <span className="text-ink-4">({formatRelative(s.expires_at)})</span>
                  </Td>
                  <Td align="right">
                    {s.current ? (
                      <Badge tone="good" size="sm">
                        текущая
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        loading={busyId === s.id}
                        onClick={() => setPendingRevoke({ kind: 'one', id: s.id })}
                      >
                        Завершить
                      </Button>
                    )}
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Завершение сессии обратимо — оператор входит заново тем же Steam-логином, —
          поэтому подтверждение обычное, а не критическое (дизайн-система, §5).
          Раньше и одна сессия, и все сразу завершались вообще без вопроса. */}
      <AlertDialog
        open={pendingRevoke !== null}
        onClose={() => {
          if (revokeBusy) return;
          setPendingRevoke(null);
        }}
        title={pendingRevoke?.kind === 'all' ? 'Завершить все сессии' : 'Завершить сессию'}
        body={
          pendingRevoke?.kind === 'all'
            ? 'Все устройства, включая это, выйдут из панели. Вам придётся войти заново.'
            : 'Устройство выйдет из панели. Войти с него можно будет заново.'
        }
        confirmLabel={pendingRevoke?.kind === 'all' ? 'Завершить все' : 'Завершить сессию'}
        cancelLabel="Отмена"
        tone="default"
        busy={revokeBusy}
        onConfirm={() => {
          if (!pendingRevoke) return;
          if (pendingRevoke.kind === 'all') void revokeAll();
          else void revokeOne(pendingRevoke.id);
        }}
      />
    </>
  );
}
