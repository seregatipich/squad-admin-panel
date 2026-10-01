'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  AlertDialog,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  FieldRow,
  GroupedList,
  GroupedRow,
  InlineBanner,
  Select,
  Switch,
  Textarea,
  TextInput,
} from '@/components/ui';
import { type ApiError, apiResult } from '@/lib/api';

export interface ClanSettingsInitial {
  name: string;
  description: string | null;
  tags: string[];
  max_priority_slots: number;
  primary_server_id: string | null;
  is_public: boolean;
  priority_expires_at: string | null;
}

interface ServerOption {
  id: string;
  display_name: string;
}

const DISBAND_COOLDOWN_MS = 3000;
const EXPIRE_PRESETS = [
  { label: '7 дней', days: 7 },
  { label: '30 дней', days: 30 },
  { label: '90 дней', days: 90 },
] as const;

const API_ERROR_MESSAGES: Record<string, string> = {
  forbidden: 'недостаточно прав',
  unauthenticated: 'сессия истекла, войдите заново',
  clan_not_found: 'клан не найден',
  clan_name_taken: 'название уже занято',
  invalid_primary_server: 'выбран недопустимый сервер',
  invalid_body: 'некорректные данные',
};

const NETWORK_ERROR_MESSAGE = 'Не удалось связаться с сервером. Повторите попытку.';

function errorBody(error: ApiError): { error?: string } {
  return error.jsonBody<{ error?: string }>() ?? {};
}

function errorMessage(prefix: string, body: { error?: string }): string {
  const reason = (body.error && API_ERROR_MESSAGES[body.error]) ?? 'неизвестная ошибка';
  return `${prefix}: ${reason}`;
}

/**
 * Clan-owner settings card (CLAN-2): rename/description/tags/slots/primary
 * server (`PATCH /:id`), priority-expiry presets (`PATCH /:id/expire`), the
 * public-visibility toggle (`PATCH /:id/settings`), and a disband danger
 * zone (`DELETE /:id`) gated behind an arm-then-wait-3s cooldown to avoid
 * accidental clicks. Only rendered for `can_manage_clans` viewers — the API
 * gates rename/slots/server changes and disband to that same flag, so a
 * clan leader without it would just get 403s here.
 *
 * Последний шаг расформирования подтверждается диалогом с вводом точного
 * названия клана: операция необратима, и по дизайн-системе (§6, §8) такое
 * подтверждение не может быть нативным `confirm()` — оно обязано назвать, что
 * именно будет уничтожено, и потребовать это набрать.
 */
export default function ClanSettingsPanel({
  clanId,
  initial,
  servers,
  onSaved,
}: {
  clanId: string;
  initial: ClanSettingsInitial;
  servers: ServerOption[];
  onSaved: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [tags, setTags] = useState(initial.tags.join(', '));
  const [maxSlots, setMaxSlots] = useState(String(initial.max_priority_slots));
  const [primaryServerId, setPrimaryServerId] = useState(initial.primary_server_id ?? '');
  const [isPublic, setIsPublic] = useState(initial.is_public);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [cooldownRemainingMs, setCooldownRemainingMs] = useState(0);
  const [armedUntil, setArmedUntil] = useState(0);
  const [disbanding, setDisbanding] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Форма перезаполняется, только когда меняются сами серверные значения, а не
  // ссылка на `initial`: страница клана перерисовывается каждую секунду, и сброс
  // по ссылке стирал бы несохранённый ввод.
  const initialName = initial.name;
  const initialDescription = initial.description ?? '';
  const initialTags = initial.tags.join(', ');
  const initialMaxSlots = String(initial.max_priority_slots);
  const initialPrimaryServerId = initial.primary_server_id ?? '';
  const initialIsPublic = initial.is_public;
  useEffect(() => {
    setName(initialName);
    setDescription(initialDescription);
    setTags(initialTags);
    setMaxSlots(initialMaxSlots);
    setPrimaryServerId(initialPrimaryServerId);
    setIsPublic(initialIsPublic);
  }, [
    initialName,
    initialDescription,
    initialTags,
    initialMaxSlots,
    initialPrimaryServerId,
    initialIsPublic,
  ]);

  useEffect(() => {
    if (!armed) return;
    // Остаток считается от момента окончания, а не накоплением тиков: один
    // интервал на всё ожидание и без дрейфа при троттлинге фоновой вкладки.
    const tick = setInterval(() => {
      const remaining = Math.max(0, armedUntil - Date.now());
      setCooldownRemainingMs(remaining);
      if (remaining === 0) clearInterval(tick);
    }, 100);
    return () => clearInterval(tick);
  }, [armed, armedUntil]);

  const saveCore = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Название не может быть пустым.');
      return;
    }
    const slots = Number.parseInt(maxSlots, 10);
    setSaving(true);
    setError(null);
    try {
      const result = await apiResult<unknown>(`/api/v1/clans/${clanId}`, {
        method: 'PATCH',
        discardBody: true,
        json: {
          name: trimmedName,
          description: description.trim() ? description.trim() : null,
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0),
          max_priority_slots: Number.isFinite(slots) ? slots : undefined,
          primary_server_id: primaryServerId || null,
        },
      });
      if (!result.ok) {
        setError(errorMessage('Не удалось сохранить изменения', errorBody(result.error)));
        return;
      }
      onSaved();
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSaving(false);
    }
  }, [clanId, name, description, tags, maxSlots, primaryServerId, onSaved]);

  const applyExpirePreset = useCallback(
    async (days: number | null) => {
      setSaving(true);
      setError(null);
      const priorityExpiresAt =
        days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString();
      try {
        const result = await apiResult<unknown>(`/api/v1/clans/${clanId}/expire`, {
          method: 'PATCH',
          discardBody: true,
          json: { priority_expires_at: priorityExpiresAt },
        });
        if (!result.ok) {
          setError(errorMessage('Не удалось изменить срок приоритета', errorBody(result.error)));
          return;
        }
        onSaved();
      } catch {
        setError(NETWORK_ERROR_MESSAGE);
      } finally {
        setSaving(false);
      }
    },
    [clanId, onSaved],
  );

  const togglePublic = useCallback(async () => {
    const next = !isPublic;
    setSaving(true);
    setError(null);
    try {
      const result = await apiResult<unknown>(`/api/v1/clans/${clanId}/settings`, {
        method: 'PATCH',
        discardBody: true,
        json: { is_public: next },
      });
      if (!result.ok) {
        setError(errorMessage('Не удалось изменить видимость', errorBody(result.error)));
        return;
      }
      setIsPublic(next);
      onSaved();
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    } finally {
      setSaving(false);
    }
  }, [clanId, isPublic, onSaved]);

  const arm = useCallback(() => {
    setArmed(true);
    setArmedUntil(Date.now() + DISBAND_COOLDOWN_MS);
    setCooldownRemainingMs(DISBAND_COOLDOWN_MS);
  }, []);

  const disband = useCallback(async () => {
    setDisbanding(true);
    setError(null);
    try {
      const result = await apiResult<unknown>(`/api/v1/clans/${clanId}`, {
        method: 'DELETE',
        discardBody: true,
      });
      if (!result.ok) {
        setError(errorMessage('Не удалось расформировать клан', errorBody(result.error)));
        setDisbanding(false);
        setConfirmOpen(false);
        return;
      }
      router.push('/clans');
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
      setDisbanding(false);
      setConfirmOpen(false);
    }
  }, [clanId, router]);

  const cooldownActive = armed && cooldownRemainingMs > 0;

  return (
    <section className="space-y-4">
      <Card padding="none">
        <CardHeader title="Настройки клана" />
        <CardBody className="space-y-4">
          {error ? (
            <InlineBanner tone="crit" title="Изменения не применены" description={error} />
          ) : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveCore();
            }}
            className="space-y-3"
          >
            <FieldRow label="Название">
              <TextInput value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
            </FieldRow>

            <FieldRow label="Описание">
              <Textarea
                value={description}
                maxLength={2000}
                rows={2}
                onChange={(e) => setDescription(e.target.value)}
              />
            </FieldRow>

            <FieldRow label="Теги через запятую">
              <TextInput value={tags} onChange={(e) => setTags(e.target.value)} />
            </FieldRow>

            <div className="grid grid-cols-2 gap-3">
              <FieldRow label="Слотов приоритета">
                <TextInput
                  type="number"
                  min={0}
                  max={999}
                  value={maxSlots}
                  onChange={(e) => setMaxSlots(e.target.value)}
                />
              </FieldRow>
              <FieldRow label="Основной сервер">
                <Select
                  value={primaryServerId}
                  onChange={(e) => setPrimaryServerId(e.target.value)}
                >
                  <option value="">Без привязки</option>
                  {servers.map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.display_name}
                    </option>
                  ))}
                </Select>
              </FieldRow>
            </div>
          </form>
        </CardBody>
        <CardFooter>
          <Button
            variant="primary"
            onClick={() => void saveCore()}
            loading={saving}
            disabled={!name.trim()}
          >
            Сохранить
          </Button>
        </CardFooter>
      </Card>

      <GroupedList>
        <GroupedRow
          label="Срок приоритета"
          description="Пресет продлевает слоты приоритета клана от текущего момента."
          control={
            <div className="flex flex-wrap items-center gap-2">
              {EXPIRE_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  size="sm"
                  disabled={saving}
                  onClick={() => void applyExpirePreset(preset.days)}
                >
                  {preset.label}
                </Button>
              ))}
              <Button size="sm" disabled={saving} onClick={() => void applyExpirePreset(null)}>
                Бессрочно
              </Button>
            </div>
          }
        />
        <GroupedRow
          label="Публичный клан"
          description="Публичные кланы видны всем в директории без ограничений."
          control={
            <span className="flex items-center gap-2">
              {/* Положение тумблера дублируется словом: состояние не кодируется
                  одной геометрией (§5). */}
              <span className="text-xs text-ink-2">{isPublic ? 'Публичный' : 'Скрытый'}</span>
              <Switch
                checked={isPublic}
                onChange={() => void togglePublic()}
                disabled={saving}
                label="Публичный клан"
              />
            </span>
          }
        />
      </GroupedList>

      <Card padding="none" className="border-crit/40">
        <CardHeader
          title="Опасная зона"
          description="Расформирование клана необратимо: ростер и приоритет всех участников будут удалены."
        />
        <CardBody>
          {!armed ? (
            <Button onClick={arm}>Расформировать клан</Button>
          ) : (
            <Button
              variant="destructive"
              disabled={cooldownActive || disbanding}
              onClick={() => setConfirmOpen(true)}
            >
              {cooldownActive
                ? `Подтвердить (${Math.ceil(cooldownRemainingMs / 1000)}с)`
                : 'Подтвердить расформирование'}
            </Button>
          )}
        </CardBody>
      </Card>

      <AlertDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Расформировать клан?"
        body={
          <>
            Клан «{initial.name}» будет удалён вместе с ростером и приоритетом всех участников.
            Отменить это нельзя.
          </>
        }
        confirmLabel="Расформировать навсегда"
        cancelLabel="Отмена"
        tone="destructive"
        busy={disbanding}
        onConfirm={() => void disband()}
        challenge={{
          expected: initial.name,
          label: `Введите название клана «${initial.name}», чтобы подтвердить`,
          hint: 'Название должно совпасть точно, включая регистр.',
        }}
      />
    </section>
  );
}
