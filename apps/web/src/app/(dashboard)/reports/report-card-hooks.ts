import { isValidBanLength } from '@squad/shared-config/ban-length';
import { useCallback, useState } from 'react';
import { ApiError, apiFetch, apiSend, describeHttpError } from '@/lib/api';
import type { ReportListItem } from '@/lib/live-bus';
import { REASON_MAX, type ReportActionType, type ReporterNotifyTemplate } from './helpers';
import { describeReportError } from './report-errors';
import type { BanAltWarning, LinkedModerationAction } from './report-types';

/** State and handlers of the "Связанные действия" list under one report card. */
export function useLinkedActions(reportId: string) {
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<LinkedModerationAction[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const body = await apiFetch<{ actions: LinkedModerationAction[] }>(
        `/api/v1/reports/${reportId}/actions`,
      );
      setActions(body.actions);
    } catch {
      setActions([]);
    } finally {
      setLoading(false);
    }
  }, [reportId]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && actions === null) void load();
  }

  return { open, actions, loading, load, toggle };
}

/**
 * State and handlers of the moderation-action modal (warn, ban, ...) opened
 * from a report card. `onSubmitted` runs after the action was accepted and
 * the modal closed.
 */
export function useReportActionModal(report: ReportListItem, onSubmitted: () => void) {
  const [type, setType] = useState<ReportActionType | null>(null);
  const [reason, setReason] = useState('');
  const [banLength, setBanLength] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banAltWarning, setBanAltWarning] = useState<BanAltWarning | null>(null);
  const [banAltWarningLoading, setBanAltWarningLoading] = useState(false);
  const [banAltWarningError, setBanAltWarningError] = useState<string | null>(null);
  const [selectedAltIds, setSelectedAltIds] = useState<string[]>([]);

  async function loadBanAltWarning(targetPlayerId: string) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2000);
    setBanAltWarningLoading(true);
    setBanAltWarningError(null);
    try {
      setBanAltWarning(
        await apiFetch<BanAltWarning>(`/api/v1/players/${targetPlayerId}/ban-alt-warning`, {
          signal: controller.signal,
        }),
      );
    } catch (error) {
      if (!controller.signal.aborted) setBanAltWarningError(describeHttpError(error));
    } finally {
      window.clearTimeout(timeout);
      setBanAltWarningLoading(false);
    }
  }

  function open(next: ReportActionType) {
    setType(next);
    setReason(report.body.slice(0, REASON_MAX));
    setBanLength('0');
    setError(null);
    setBanAltWarning(null);
    setBanAltWarningError(null);
    setSelectedAltIds([]);
    if (next === 'ban' && report.target_player_id) void loadBanAltWarning(report.target_player_id);
  }

  function close() {
    setType(null);
  }

  function toggleAlt(playerId: string) {
    setSelectedAltIds((current) =>
      current.includes(playerId) ? current.filter((id) => id !== playerId) : [...current, playerId],
    );
  }

  async function submit() {
    if (!type) return;
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError('Укажите причину.');
      return;
    }
    if (type === 'ban' && !isValidBanLength(banLength)) {
      setError('Некорректный срок бана.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { action_type: type, reason: trimmedReason };
      if (type === 'ban') {
        body.ban_length = banLength.trim() || '0';
        if (selectedAltIds.length > 0) body.also_player_ids = selectedAltIds;
      }
      await apiSend(`/api/v1/reports/${report.id}/actions`, { method: 'POST', json: body });
      setType(null);
      onSubmitted();
    } catch (e) {
      setError(describeReportError(e));
    } finally {
      setBusy(false);
    }
  }

  return {
    type,
    reason,
    setReason,
    banLength,
    setBanLength,
    busy,
    error,
    banAltWarning,
    banAltWarningLoading,
    banAltWarningError,
    selectedAltIds,
    open,
    close,
    toggleAlt,
    submit,
  };
}

export type ReportActionModalState = ReturnType<typeof useReportActionModal>;

/** State and handler of the "Уведомить репортёра" control of one report card. */
export function useReporterNotify(reportId: string) {
  const [template, setTemplate] = useState<ReporterNotifyTemplate>('in_review');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      await apiSend(`/api/v1/reports/${reportId}/notify-reporter`, {
        method: 'POST',
        json: { template },
      });
      setMessage({ kind: 'ok', text: 'Уведомление отправлено.' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setMessage({ kind: 'err', text: 'Репортёр не в сети' });
        return;
      }
      setMessage({ kind: 'err', text: describeReportError(e) });
    } finally {
      setBusy(false);
    }
  }

  return { template, setTemplate, busy, message, dismissMessage: () => setMessage(null), submit };
}
