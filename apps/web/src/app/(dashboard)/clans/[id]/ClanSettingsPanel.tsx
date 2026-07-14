'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useState } from 'react';

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

function errorMessage(prefix: string, body: { error?: string }): string {
  return `${prefix}: ${body.error ?? 'unknown'}`;
}

/**
 * Clan-owner settings card (CLAN-2): rename/description/tags/slots/primary
 * server (`PATCH /:id`), priority-expiry presets (`PATCH /:id/expire`), the
 * public-visibility toggle (`PATCH /:id/settings`), and a disband danger
 * zone (`DELETE /:id`) gated behind an arm-then-wait-3s cooldown to avoid
 * accidental clicks. Only rendered for `can_manage_clans` viewers — the API
 * gates rename/slots/server changes and disband to that same flag, so a
 * clan leader without it would just get 403s here.
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
  const [disbanding, setDisbanding] = useState(false);

  const nameId = useId();
  const descriptionId = useId();
  const tagsId = useId();
  const slotsId = useId();
  const serverId = useId();

  useEffect(() => {
    setName(initial.name);
    setDescription(initial.description ?? '');
    setTags(initial.tags.join(', '));
    setMaxSlots(String(initial.max_priority_slots));
    setPrimaryServerId(initial.primary_server_id ?? '');
    setIsPublic(initial.is_public);
  }, [initial]);

  useEffect(() => {
    if (!armed || cooldownRemainingMs <= 0) return;
    const tick = setInterval(() => {
      setCooldownRemainingMs((prev) => Math.max(0, prev - 100));
    }, 100);
    return () => clearInterval(tick);
  }, [armed, cooldownRemainingMs]);

  const saveCore = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedName = name.trim();
      if (!trimmedName) {
        setError('Название не может быть пустым.');
        return;
      }
      const slots = Number.parseInt(maxSlots, 10);
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(`/api/v1/clans/${clanId}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: trimmedName,
            description: description.trim() ? description.trim() : null,
            tags: tags
              .split(',')
              .map((tag) => tag.trim())
              .filter((tag) => tag.length > 0),
            max_priority_slots: Number.isFinite(slots) ? slots : undefined,
            primary_server_id: primaryServerId || null,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(errorMessage('Не удалось сохранить изменения', body));
          return;
        }
        onSaved();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [clanId, name, description, tags, maxSlots, primaryServerId, onSaved],
  );

  const applyExpirePreset = useCallback(
    async (days: number | null) => {
      setSaving(true);
      setError(null);
      const priorityExpiresAt =
        days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString();
      try {
        const res = await fetch(`/api/v1/clans/${clanId}/expire`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ priority_expires_at: priorityExpiresAt }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(errorMessage('Не удалось изменить срок приоритета', body));
          return;
        }
        onSaved();
      } catch (e) {
        setError((e as Error).message);
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
      const res = await fetch(`/api/v1/clans/${clanId}/settings`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ is_public: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(errorMessage('Не удалось изменить видимость', body));
        return;
      }
      setIsPublic(next);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [clanId, isPublic, onSaved]);

  const arm = useCallback(() => {
    setArmed(true);
    setCooldownRemainingMs(DISBAND_COOLDOWN_MS);
  }, []);

  const disband = useCallback(async () => {
    if (!window.confirm(`Расформировать клан «${initial.name}»? Это действие необратимо.`)) return;
    setDisbanding(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/clans/${clanId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(errorMessage('Не удалось расформировать клан', body));
        setDisbanding(false);
        return;
      }
      router.push('/clans');
    } catch (e) {
      setError((e as Error).message);
      setDisbanding(false);
    }
  }, [clanId, initial.name, router]);

  const cooldownActive = armed && cooldownRemainingMs > 0;

  return (
    <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-950 p-5">
      <h2 className="text-lg font-medium">Настройки клана</h2>

      {error ? (
        <div className="rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}

      <form onSubmit={saveCore} className="space-y-3">
        <div>
          <label htmlFor={nameId} className="mb-1 block text-xs text-neutral-500">
            Название
          </label>
          <input
            id={nameId}
            type="text"
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor={descriptionId} className="mb-1 block text-xs text-neutral-500">
            Описание
          </label>
          <textarea
            id={descriptionId}
            value={description}
            maxLength={2000}
            rows={2}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor={tagsId} className="mb-1 block text-xs text-neutral-500">
            Теги через запятую
          </label>
          <input
            id={tagsId}
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={slotsId} className="mb-1 block text-xs text-neutral-500">
              Слотов приоритета
            </label>
            <input
              id={slotsId}
              type="number"
              min={0}
              max={999}
              value={maxSlots}
              onChange={(e) => setMaxSlots(e.target.value)}
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor={serverId} className="mb-1 block text-xs text-neutral-500">
              Основной сервер
            </label>
            <select
              id={serverId}
              value={primaryServerId}
              onChange={(e) => setPrimaryServerId(e.target.value)}
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-neutral-600 focus:outline-none"
            >
              <option value="">Без привязки</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.display_name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="rounded bg-sky-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </form>

      <div className="space-y-2 border-t border-neutral-900 pt-4">
        <div className="text-xs uppercase tracking-widest text-neutral-500">Срок приоритета</div>
        <div className="flex flex-wrap gap-2">
          {EXPIRE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              disabled={saving}
              onClick={() => void applyExpirePreset(preset.days)}
              className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            disabled={saving}
            onClick={() => void applyExpirePreset(null)}
            className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            Бессрочно
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-neutral-900 pt-4">
        <div>
          <div className="text-sm font-medium text-neutral-200">Публичный клан</div>
          <p className="text-xs text-neutral-500">
            Публичные кланы видны всем в директории без ограничений.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void togglePublic()}
          disabled={saving}
          aria-pressed={isPublic}
          className={`shrink-0 rounded px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
            isPublic
              ? 'border border-emerald-800 bg-emerald-950 text-emerald-300 hover:bg-emerald-900'
              : 'border border-neutral-800 bg-neutral-900 text-neutral-300 hover:bg-neutral-800'
          }`}
        >
          {isPublic ? 'Публичный' : 'Скрытый'}
        </button>
      </div>

      <div className="space-y-2 rounded border border-red-950 bg-red-950/20 p-4">
        <div className="text-xs uppercase tracking-widest text-red-400">Опасная зона</div>
        <p className="text-xs text-neutral-400">
          Расформирование клана необратимо: ростер и приоритет всех участников будут удалены.
        </p>
        {!armed ? (
          <button
            type="button"
            onClick={arm}
            className="rounded border border-red-900 bg-red-950/40 px-3 py-1.5 text-sm text-red-300 hover:bg-red-900/40"
          >
            Расформировать клан
          </button>
        ) : (
          <button
            type="button"
            disabled={cooldownActive || disbanding}
            onClick={() => void disband()}
            className="rounded border border-red-900 bg-red-950/40 px-3 py-1.5 text-sm text-red-300 hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {disbanding
              ? 'Расформирование…'
              : cooldownActive
                ? `Подтвердить (${Math.ceil(cooldownRemainingMs / 1000)}с)`
                : 'Подтвердить расформирование'}
          </button>
        )}
      </div>
    </section>
  );
}
