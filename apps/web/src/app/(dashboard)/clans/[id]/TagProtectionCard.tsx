'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, CardBody, CardHeader, InlineBanner, Switch } from '@/components/ui';

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
 *
 * Состояние переключателя всегда продублировано словом рядом с ним: положение
 * тумблера — это цвет и геометрия, а по дизайн-системе (§5) ни то, ни другое
 * не имеет права быть единственным носителем смысла.
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

  const stateLabel = isProtected ? 'Защита включена' : 'Защита выключена';

  return (
    <Card padding="none">
      <CardHeader
        title="Защита тега"
        description="Игроков без места в ростере, носящих тег этого клана, автоматика предупреждает и, если ник не сменён за грейс-период, кикает. Настройки грейс-периода и глобальный выключатель — на странице «Защита клан-тегов»."
        actions={
          canToggle ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-ink-2">{stateLabel}</span>
              <Switch
                checked={isProtected}
                onChange={() => void toggle()}
                disabled={saving}
                label="Защита тега"
              />
            </span>
          ) : (
            <Badge tone={isProtected ? 'good' : 'neutral'}>{stateLabel}</Badge>
          )
        }
      />
      {error ? (
        <CardBody>
          <InlineBanner tone="crit" title="Настройка не изменена" description={error} />
        </CardBody>
      ) : null}
    </Card>
  );
}
