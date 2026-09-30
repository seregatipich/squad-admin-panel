'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BannedNameRuleModal } from '@/components/BannedNameRuleModal';
import { AlertDialog, Badge, Button, ButtonLink, InlineBanner } from '@/components/ui';
import { buildCheckUrl, type NickBanCheckResponse, ruleHref } from './nick-ban';

/**
 * BANNAME-3 — checks whether the player's current canonical name matches an
 * active `banned_name_rules` row and renders either a «Ник забанен» badge
 * (with a link to the rule and a «Разбанить ник» quick action) or a
 * «Забанить ник» button that opens the shared prefilled create modal.
 * Hidden only on 401/403 (viewers without panel access never see it); any
 * other failure keeps the block with «Повторить» (#450). Each check carries a
 * sequence number and only the latest one may update the block, so a slow
 * earlier answer cannot overwrite a newer re-check.
 */
export function NickBanSection({
  nick,
  refreshKey,
}: {
  nick: string;
  /** Bump this (e.g. after banning a historical nick) to force a re-check. */
  refreshKey?: number;
}) {
  const [check, setCheck] = useState<NickBanCheckResponse | null>(null);
  const [hidden, setHidden] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [unbanOpen, setUnbanOpen] = useState(false);
  const [unbanning, setUnbanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++latestRequest.current;
    const isCurrent = () => requestId === latestRequest.current;
    setHidden(false);
    try {
      const res = await fetch(buildCheckUrl(nick), { credentials: 'include', cache: 'no-store' });
      if (!isCurrent()) return;
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as NickBanCheckResponse;
      if (!isCurrent()) return;
      setCheck(body);
      setLoadError(null);
    } catch (err) {
      if (isCurrent()) setLoadError((err as Error).message);
    }
  }, [nick]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate re-check trigger, not read in the effect body
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (hidden) return null;

  if (loadError && !check) {
    return (
      <InlineBanner
        tone="warn"
        title="Не удалось проверить ник"
        description={loadError}
        action={
          <Button size="sm" onClick={() => void load()}>
            Повторить
          </Button>
        }
      />
    );
  }

  if (!check) return null;

  async function unban() {
    if (!check?.rule) return;
    setUnbanning(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/banned-names/${check.rule.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ is_active: false }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setUnbanOpen(false);
      await load();
    } catch (unbanError) {
      setError((unbanError as Error).message);
    } finally {
      setUnbanning(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {check.matched && check.rule ? (
        <>
          <Badge tone="crit">Ник забанен</Badge>
          <ButtonLink href={ruleHref(check.rule.id)} variant="plain" size="sm">
            Правило
          </ButtonLink>
          {check.can_mutate ? (
            <Button size="sm" onClick={() => setUnbanOpen(true)}>
              Разбанить ник
            </Button>
          ) : null}
        </>
      ) : check.can_mutate ? (
        <Button size="sm" variant="destructive" onClick={() => setModalOpen(true)}>
          Забанить ник
        </Button>
      ) : null}

      {error ? <p className="text-xs text-crit">{error}</p> : null}
      {loadError ? (
        <p className="flex items-center gap-2 text-xs text-warn">
          Не удалось перепроверить ник: {loadError}
          <Button size="sm" variant="plain" onClick={() => void load()}>
            Повторить
          </Button>
        </p>
      ) : null}

      <BannedNameRuleModal
        open={modalOpen}
        initial={{ pattern: nick, match_type: 'exact' }}
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          setModalOpen(false);
          void load();
        }}
      />

      {/* Снятие бана обратимо — правило можно включить снова, поэтому тон
          обычный, а не критический (§5). */}
      <AlertDialog
        open={unbanOpen}
        onClose={() => setUnbanOpen(false)}
        title="Разбанить ник"
        body={
          check.rule
            ? `Ник «${nick}» перестанет считаться забаненным: правило «${check.rule.pattern}» будет отключено.`
            : ''
        }
        confirmLabel="Разбанить ник"
        cancelLabel="Отмена"
        tone="default"
        busy={unbanning}
        onConfirm={unban}
      />
    </div>
  );
}
