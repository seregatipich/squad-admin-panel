'use client';
import { type RefObject, useCallback, useMemo, useState } from 'react';
import { apiFetch, apiSend, describeHttpError } from '@/lib/api';
import { useApiResource } from '@/lib/use-polled-resource';
import { isHardFailure, POLL_MS } from './config-model';
import type { DriftDiff, DriftItem } from './DriftPanel';

/**
 * Config drift banner and its resolution (CFG-2, #64): files whose content on
 * disk diverged from the last version the panel stored. The state is polled
 * (best-effort: a transient error keeps the last known state) while the tab is
 * visible.
 *
 * @param serverId Server whose files are checked.
 * @param selectedRef Always holds the open file's name, so resolving the open
 *   file reloads it.
 * @param onError Receives the text of a failed request; `null` clears it.
 * @param onMessage Receives the confirmation text of a resolution; `null` clears it.
 * @param reloadFile Reloads the open file after its drift was resolved.
 * @returns The drifted items, the open diff, the busy file name and the actions.
 */
export function useConfigDrift(
  serverId: string,
  selectedRef: RefObject<string | null>,
  onError: (message: string | null) => void,
  onMessage: (message: string | null) => void,
  reloadFile: (name: string) => Promise<void>,
) {
  const [driftDiff, setDriftDiff] = useState<DriftDiff | null>(null);
  const [driftBusy, setDriftBusy] = useState<string | null>(null);

  const { data: driftData, refresh: refreshDrift } = useApiResource<{ items: DriftItem[] }>(
    `/api/v1/servers/${serverId}/configs/drift`,
    { intervalMs: POLL_MS, pauseWhenHidden: true, stopPolling: isHardFailure },
  );
  const driftItems = useMemo(
    () => driftData?.items.filter((i) => i.state === 'drift') ?? [],
    [driftData],
  );

  const openDriftDiff = useCallback(
    async (item: DriftItem) => {
      onError(null);
      try {
        let tip = '';
        if (item.tip_version_id) {
          tip = (
            await apiFetch<{ content: string }>(
              `/api/v1/servers/${serverId}/configs/${item.name}/versions/${item.tip_version_id}`,
            )
          ).content;
        }
        const disk = (
          await apiFetch<{ content: string }>(`/api/v1/servers/${serverId}/configs/${item.name}`)
        ).content;
        setDriftDiff({ name: item.name, tip, disk });
      } catch (e) {
        onError(describeHttpError(e));
      }
    },
    [serverId, onError],
  );

  const closeDriftDiff = useCallback(() => setDriftDiff(null), []);

  const resolveDrift = useCallback(
    async (name: string, action: 'accept' | 'revert') => {
      setDriftBusy(name);
      onError(null);
      onMessage(null);
      try {
        await apiSend(`/api/v1/servers/${serverId}/configs/${name}/drift/${action}`, {
          method: 'POST',
          json: {},
        });
        onMessage(
          action === 'accept'
            ? `${name}: правка с диска принята как новая версия`
            : `${name}: файл восстановлен из версии панели`,
        );
        setDriftDiff(null);
        await refreshDrift();
        if (selectedRef.current === name) await reloadFile(name);
      } catch (e) {
        onError(describeHttpError(e, true));
      } finally {
        setDriftBusy(null);
      }
    },
    [serverId, selectedRef, onError, onMessage, refreshDrift, reloadFile],
  );

  return {
    driftItems,
    driftDiff,
    driftBusy,
    refreshDrift,
    openDriftDiff,
    closeDriftDiff,
    resolveDrift,
  };
}
