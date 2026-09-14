'use client';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  FieldRow,
  InlineBanner,
  PageHeader,
  SkeletonTable,
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  TextInput,
  Th,
} from '@/components/ui';

const POLL_MS = 30_000;

interface Me {
  steam_id64: string;
  canonical_name: string;
  permissions: string[];
}

interface ApiToken {
  id: string;
  name: string;
  scopes: string[];
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface CreateResponse extends ApiToken {
  plaintext: string;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU');
}

export default function TokensPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<ApiToken | null>(null);
  const [justCreated, setJustCreated] = useState<CreateResponse | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const nameInputId = useId();

  const sortedPermissions = useMemo(() => (me ? [...me.permissions].sort() : []), [me]);

  const load = useCallback(async () => {
    try {
      const [meRes, tokRes] = await Promise.all([
        fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/v1/me/tokens', { credentials: 'include', cache: 'no-store' }),
      ]);
      if (!meRes.ok) throw new Error(`HTTP ${meRes.status}`);
      if (!tokRes.ok) throw new Error(`HTTP ${tokRes.status}`);
      setMe((await meRes.json()) as Me);
      setTokens((await tokRes.json()) as ApiToken[]);
      // Удачный опрос отменяет ошибку, но не подтверждение действия: «Токен
      // отозван» оператор должен успеть прочитать.
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

  function toggleScope(key: string) {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function createToken(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setMsg({ kind: 'err', text: 'Укажите имя токена.' });
      return;
    }
    setCreating(true);
    setMsg(null);
    try {
      const res = await fetch('/api/v1/me/tokens', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          scopes: Array.from(selectedScopes),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(`HTTP ${res.status}: ${body.error ?? 'unknown'}`);
      }
      const created = (await res.json()) as CreateResponse;
      setJustCreated(created);
      setTokens((prev) => [
        ...prev,
        {
          id: created.id,
          name: created.name,
          scopes: created.scopes,
          last_used_at: null,
          created_at: created.created_at,
          revoked_at: null,
        },
      ]);
      setName('');
      setSelectedScopes(new Set());
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setCreating(false);
    }
  }

  async function revokeToken(id: string) {
    setRevokingId(id);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/me/tokens/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTokens((prev) =>
        prev.map((t) => (t.id === id ? { ...t, revoked_at: new Date().toISOString() } : t)),
      );
      setMsg({ kind: 'ok', text: 'Токен отозван.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setRevokingId(null);
      setPendingRevoke(null);
    }
  }

  async function copyPlaintext() {
    if (!justCreated) return;
    try {
      await navigator.clipboard.writeText(justCreated.plaintext);
      setMsg({ kind: 'ok', text: 'Токен скопирован в буфер обмена.' });
    } catch (e) {
      setMsg({ kind: 'err', text: `Не удалось скопировать: ${(e as Error).message}` });
    }
  }

  return (
    <>
      <PageHeader
        title="API-токены"
        subtitle="Токены позволяют скриптам и интеграциям обращаться к API панели от вашего имени. Скоупы — подмножество ваших прав; если у вас отнимут роль, токен немедленно потеряет соответствующие разрешения. Токен показывается полностью только один раз при создании."
      />

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

      {justCreated ? (
        <InlineBanner
          tone="warn"
          title="Сохраните токен сейчас — он больше не будет показан"
          description={
            <div className="space-y-2">
              <code className="block break-all rounded-ctl bg-raised px-2.5 py-2 font-mono text-xs text-ink">
                {justCreated.plaintext}
              </code>
              <Button size="sm" onClick={() => void copyPlaintext()}>
                Скопировать
              </Button>
            </div>
          }
          onDismiss={() => setJustCreated(null)}
          dismissLabel="Скрыть токен"
        />
      ) : null}

      <Card padding="none">
        <CardHeader title="Создать токен" />
        <CardBody>
          <form onSubmit={createToken} className="space-y-3">
            <FieldRow label="Имя" htmlFor={nameInputId}>
              <TextInput
                id={nameInputId}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                placeholder="напр. CI runner, Discord bot"
              />
            </FieldRow>
            <fieldset className="space-y-1">
              <legend className="text-xs font-medium text-ink-2">
                Скоупы ({selectedScopes.size} из {sortedPermissions.length})
              </legend>
              <div className="grid max-h-72 grid-cols-1 gap-x-4 gap-y-1 overflow-y-auto rounded-ctl border border-line bg-raised p-3 sm:grid-cols-2">
                {me === null ? (
                  <div className="sm:col-span-2">
                    <SkeletonTable rows={3} cols={2} label="Загрузка списка прав" />
                  </div>
                ) : sortedPermissions.length === 0 ? (
                  <div className="text-xs text-ink-3 sm:col-span-2">
                    У вас нет разрешений — токен можно создать только с пустым набором скоупов
                    (только для интроспекции профиля).
                  </div>
                ) : (
                  sortedPermissions.map((key) => (
                    <Checkbox
                      key={key}
                      label={<span className="font-mono">{key}</span>}
                      checked={selectedScopes.has(key)}
                      onChange={() => toggleScope(key)}
                    />
                  ))
                )}
              </div>
            </fieldset>
            <Button type="submit" variant="primary" loading={creating}>
              Создать токен
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card padding="none">
        <CardHeader title="Существующие" count={tokens.length > 0 ? tokens.length : undefined} />
        {me === null ? (
          <div className="p-3">
            <SkeletonTable rows={3} cols={6} label="Загрузка списка токенов" />
          </div>
        ) : tokens.length === 0 ? (
          <EmptyState
            title="Токенов пока нет"
            description="Создайте токен выше, чтобы скрипт или интеграция могли обращаться к API."
          />
        ) : (
          <Table ariaLabel="API-токены">
            <TableHead>
              <tr>
                <Th>Имя</Th>
                <Th>Скоупы</Th>
                <Th>Создан</Th>
                <Th>Использован</Th>
                <Th>Статус</Th>
                <Th align="right" width="8rem">
                  Действие
                </Th>
              </tr>
            </TableHead>
            <TableBody>
              {tokens.map((t) => (
                <TableRow key={t.id} interactive>
                  <Td>{t.name}</Td>
                  <Td>
                    {t.scopes.length === 0 ? (
                      <span className="text-xs text-ink-3">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {t.scopes.map((s) => (
                          <Badge key={s} size="sm">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </Td>
                  <Td className="text-xs text-ink-3">{formatDate(t.created_at)}</Td>
                  <Td className="text-xs text-ink-3">{formatDate(t.last_used_at)}</Td>
                  <Td>
                    {t.revoked_at ? (
                      <Badge tone="crit" size="sm">
                        отозван
                      </Badge>
                    ) : (
                      <Badge tone="good" size="sm">
                        активен
                      </Badge>
                    )}
                  </Td>
                  <Td align="right">
                    {t.revoked_at ? null : (
                      <Button
                        size="sm"
                        loading={revokingId === t.id}
                        onClick={() => setPendingRevoke(t)}
                      >
                        Отозвать
                      </Button>
                    )}
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Отзыв необратим — тот же секрет обратно не выдаётся, — поэтому тон
          критический (дизайн-система, §5). Ввода строки-подтверждения нет:
          уничтожается один ключ доступа, а не данные, и его владелец всегда
          может выпустить новый. */}
      <AlertDialog
        open={pendingRevoke !== null}
        onClose={() => {
          if (revokingId !== null) return;
          setPendingRevoke(null);
        }}
        title="Отозвать токен"
        body={
          pendingRevoke
            ? `Токен «${pendingRevoke.name}» перестанет работать сразу же, и всё, что им пользуется, получит 401. Это действие необратимо — восстановить тот же секрет нельзя, только выпустить новый.`
            : ''
        }
        confirmLabel="Отозвать токен"
        cancelLabel="Отмена"
        tone="destructive"
        busy={revokingId !== null}
        onConfirm={() => {
          if (pendingRevoke) void revokeToken(pendingRevoke.id);
        }}
      />
    </>
  );
}
