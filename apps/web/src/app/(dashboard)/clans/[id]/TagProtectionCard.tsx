'use client';

import { useCallback, useEffect, useState } from 'react';

interface TagProtectionCardProps {
  clanId: string;
  initialProtected: boolean;
}

interface ClanSettingsResponse {
  is_tag_protected: boolean;
}

/**
 * Clan-tag-protection toggle (CLAN-5) co-located on the clan detail page.
 * Renders the toggle optimistically for every viewer — the PATCH route
 * (`/api/v1/clans/:id/settings`) is the actual authority on who may flip it
 * (`can_manage_clans`, or the clan's own leader/deputy). A 401/403 response
 * hides the interactive control for the rest of the session and falls back
 * to a read-only status badge, matching the player-card section pattern.
 */
export default function TagProtectionCard({ clanId, initialProtected }: TagProtectionCardProps) {
  const [isProtected, setIsProtected] = useState(initialProtected);
  const [canToggle, setCanToggle] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsProtected(initialProtected);
  }, [initialProtected]);

  const toggle = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/clans/${clanId}/settings`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ is_tag_protected: !isProtected }),
      });
      if (res.status === 401 || res.status === 403) {
        setCanToggle(false);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(`Не удалось изменить настройку: ${body.error ?? res.status}`);
        return;
      }
      const body = (await res.json()) as ClanSettingsResponse;
      setIsProtected(body.is_tag_protected);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [clanId, isProtected]);

  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">Защита тега</h2>
          <p className="mt-1 max-w-xl text-xs text-neutral-500">
            Игроков без места в ростере, носящих тег этого клана, автоматика предупреждает и, если
            ник не сменён за грейс-период, кикает. Настройки грейс-периода и глобальный выключатель
            — на странице «Защита клан-тегов».
          </p>
        </div>
        {canToggle ? (
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={saving}
            aria-pressed={isProtected}
            className={`shrink-0 rounded px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
              isProtected
                ? 'border border-emerald-800 bg-emerald-950 text-emerald-300 hover:bg-emerald-900'
                : 'border border-neutral-800 bg-neutral-900 text-neutral-300 hover:bg-neutral-800'
            }`}
          >
            {saving ? 'Сохраняем…' : isProtected ? 'Защита включена' : 'Защита выключена'}
          </button>
        ) : (
          <span
            className={`shrink-0 rounded px-2 py-0.5 text-xs ${
              isProtected ? 'bg-emerald-950 text-emerald-300' : 'bg-neutral-800 text-neutral-400'
            }`}
          >
            {isProtected ? 'Защита включена' : 'Защита выключена'}
          </span>
        )}
      </div>
      {error ? (
        <div className="mt-3 rounded border border-red-900 bg-red-950 p-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}
    </section>
  );
}
