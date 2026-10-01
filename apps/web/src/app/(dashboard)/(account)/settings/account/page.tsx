'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DossierSection } from '@/components/DossierSection';
import { RecentMatchesSection } from '@/components/RecentMatchesSection';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardHeader,
  GroupedList,
  GroupedRow,
  InlineBanner,
  PageContainer,
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
import { apiFetch, apiSend, describeHttpError } from '@/lib/api';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { AccountIdentity } from './AccountIdentity';
import {
  type AccountNames,
  describeDevice,
  formatDate,
  formatPermissionCount,
  formatRelative,
} from './helpers';

type SessionRevokedEvent = Extract<LiveEvent, { type: 'session.revoked' }>;

const POLL_MS = 30_000;

interface Me {
  player_id: string;
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
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<PendingRevoke | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  // Bumped by every session-list mutation (revokeOne). loadSessions captures
  // the revision it started with and discards its response if a mutation
  // landed in the meantime, so a poll started before revokeOne can never
  // repopulate a row it just removed (#427).
  const sessionsRevisionRef = useRef(0);
  // Which request last failed, so the error banner's "Повторить" retries
  // that request instead of always reloading everything (#426).
  const lastFailedRef = useRef<'profile' | 'sessions' | null>(null);

  const onSessionRevoked = useCallback((event: SessionRevokedEvent) => {
    // Redirecting *this* tab when its own session is the one revoked is
    // <ForcedLogout />'s job — it is mounted once in the dashboard layout and
    // already handles every session.revoked event globally. Duplicating that
    // check here only served to remove the row from the table (#428).
    setSessions((prev) => prev.filter((s) => s.id !== event.data.session_id));
  }, []);
  useLiveSubscription('session.revoked', onSessionRevoked);

  // Права и история ников не меняются в пределах визита: опрашивать их
  // повторно незачем, они загружаются один раз при монтировании (#426).
  const loadProfile = useCallback(async () => {
    try {
      const [loadedMe, loadedNames] = await Promise.all([
        apiFetch<Me>('/api/v1/me'),
        apiFetch<AccountNames>('/api/v1/me/names'),
      ]);
      setMe(loadedMe);
      setNames(loadedNames);
      // Снимается только сообщение об ошибке от ЭТОГО же запроса: удачный
      // опрос профиля не должен стирать ошибку сессий (и наоборот), а
      // подтверждение «Сессия завершена» опрос вообще не имеет права стереть.
      if (lastFailedRef.current === 'profile') {
        lastFailedRef.current = null;
        setMsg((prev) => (prev?.kind === 'err' ? null : prev));
      }
    } catch (e) {
      lastFailedRef.current = 'profile';
      setMsg({ kind: 'err', text: describeHttpError(e) });
    }
  }, []);

  const loadSessions = useCallback(async () => {
    const revision = sessionsRevisionRef.current;
    try {
      const data = await apiFetch<ActiveSession[]>('/api/v1/me/sessions');
      if (sessionsRevisionRef.current !== revision) return;
      setSessions(data);
      setSessionsLoaded(true);
      if (lastFailedRef.current === 'sessions') {
        lastFailedRef.current = null;
        setMsg((prev) => (prev?.kind === 'err' ? null : prev));
      }
    } catch (e) {
      if (sessionsRevisionRef.current !== revision) return;
      setSessionsLoaded(true);
      lastFailedRef.current = 'sessions';
      setMsg({ kind: 'err', text: describeHttpError(e) });
    }
  }, []);

  const retry = useCallback(() => {
    if (lastFailedRef.current === 'sessions') void loadSessions();
    else void loadProfile();
  }, [loadProfile, loadSessions]);

  useEffect(() => {
    void loadProfile();
    void loadSessions();
  }, [loadProfile, loadSessions]);

  useEffect(() => {
    const t = setInterval(() => {
      // Списко сессий и так обновляется событием session.revoked; опрос в
      // скрытой вкладке — трата запроса без наблюдателя (#426).
      if (document.visibilityState !== 'visible') return;
      void loadSessions();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [loadSessions]);

  async function revokeOne(id: string) {
    setBusyId(id);
    setMsg(null);
    try {
      await apiSend(`/api/v1/me/sessions/${id}`, { method: 'DELETE' });
      sessionsRevisionRef.current++;
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setMsg({ kind: 'ok', text: 'Сессия завершена.' });
    } catch (e) {
      setMsg({ kind: 'err', text: describeHttpError(e) });
    } finally {
      setBusyId(null);
      setPendingRevoke(null);
    }
  }

  async function revokeAll() {
    setRevokingAll(true);
    setMsg(null);
    try {
      await apiSend('/api/v1/me/sessions', { method: 'DELETE' });
      window.location.href = '/login';
    } catch (e) {
      setMsg({ kind: 'err', text: describeHttpError(e) });
      setRevokingAll(false);
      setPendingRevoke(null);
    }
  }

  const revokeBusy = pendingRevoke?.kind === 'all' ? revokingAll : busyId !== null;

  return (
    <>
      {/* Ширина `full`, а не `reading` раздела «Настройки»: страница давно
          переросла профиль и вход — на ней таблицы оружия, техники и матчей,
          которым колонка в 768px тесна. Ради этого маршрут и вынесен в группу
          `(account)`: адрес прежний, а вот каркас настроек его больше не
          оборачивает. */}
      <PageContainer width="full">
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
                <Button size="sm" onClick={retry}>
                  Повторить
                </Button>
              ) : undefined
            }
            onDismiss={() => setMsg(null)}
            dismissLabel="Скрыть сообщение"
          />
        ) : null}

        {/* Статистика стоит выше профиля намеренно: SteamID64 и число ключей
          оператор смотрит раз в жизни, а свои цифры — постоянно. Блоки те же,
          что и на карточке игрока: маршрут досье пропускает владельца сессии
          без `combat:view`, а «Последние матчи» и так открыты любому, у кого
          есть доступ в панель. */}
        {me === null ? null : (
          <>
            <DossierSection
              playerId={me.player_id}
              title="Игровая статистика"
              serverFilter={false}
            />
            <RecentMatchesSection playerId={me.player_id} />
          </>
        )}

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
          {!sessionsLoaded ? (
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
      </PageContainer>

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
