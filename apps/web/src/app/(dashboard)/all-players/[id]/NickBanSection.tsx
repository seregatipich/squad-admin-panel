'use client';

import { useCallback, useEffect, useState } from 'react';
import { BannedNameRuleModal } from '@/components/BannedNameRuleModal';
import { buildCheckUrl, type NickBanCheckResponse, ruleHref } from './nick-ban';

/**
 * BANNAME-3 — checks whether the player's current canonical name matches an
 * active `banned_name_rules` row and renders either a «Ник забанен» badge
 * (with a link to the rule and a «Разбанить ник» quick action) or a
 * «Забанить ник» button that opens the shared prefilled create modal.
 * Hidden entirely on 401/403 (viewers without panel access never see it).
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
  const [unbanning, setUnbanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(buildCheckUrl(nick), { credentials: 'include', cache: 'no-store' });
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCheck((await res.json()) as NickBanCheckResponse);
    } catch {
      setHidden(true);
    }
  }, [nick]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate re-check trigger, not read in the effect body
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (hidden || !check) return null;

  async function unban() {
    if (!check?.rule) return;
    if (!confirm(`Разбанить ник «${nick}»? Правило «${check.rule.pattern}» будет отключено.`)) {
      return;
    }
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
          <span className="rounded bg-red-950 px-2 py-0.5 text-xs uppercase text-red-300">
            Ник забанен
          </span>
          <a href={ruleHref(check.rule.id)} className="text-xs text-sky-400 hover:text-sky-300">
            Правило
          </a>
          {check.can_mutate ? (
            <button
              type="button"
              onClick={() => void unban()}
              disabled={unbanning}
              className="rounded border border-red-900 px-2 py-0.5 text-xs text-red-300 hover:border-red-700 disabled:opacity-40"
            >
              {unbanning ? '…' : 'Разбанить ник'}
            </button>
          ) : null}
        </>
      ) : check.can_mutate ? (
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="rounded border border-red-900 px-2 py-0.5 text-xs text-red-400 hover:border-red-700"
        >
          Забанить ник
        </button>
      ) : null}

      {error ? <p className="text-xs text-red-400">{error}</p> : null}

      <BannedNameRuleModal
        open={modalOpen}
        initial={{ pattern: nick, match_type: 'exact' }}
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          setModalOpen(false);
          void load();
        }}
      />
    </div>
  );
}
