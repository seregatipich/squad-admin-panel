'use client';
import { type RefObject, useEffect } from 'react';
import { apiFetch } from '@/lib/api';
import { isHardFailure, POLL_MS } from './config-model';

/**
 * Polls the open file while the tab is visible and reports when its content on
 * disk no longer matches the version the editor was loaded from. A hard
 * failure of the route stops the poll; any other error is transient.
 *
 * @param serverId Server owning the file.
 * @param selected Name of the open file; the poll is idle while it is `null`.
 * @param selectedRef Always holds the current `selected`, so a response for a
 *   file the operator already left is dropped.
 * @param serverShaRef Always holds the sha256 the editor content was loaded from.
 * @param onExternalChange Called with the newer sha256 and content found on disk.
 */
export function useExternalChangeWatch(
  serverId: string,
  selected: string | null,
  selectedRef: RefObject<string | null>,
  serverShaRef: RefObject<string | null>,
  onExternalChange: (change: { sha: string; content: string }) => void,
) {
  useEffect(() => {
    if (!selected) return;
    const lifetime = new AbortController();
    let stopped = false;
    async function poll() {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (stopped) return;
      const target = selectedRef.current;
      if (!target || document.visibilityState !== 'visible') return;
      try {
        const j = await apiFetch<{ content: string; sha256: string | null }>(
          `/api/v1/servers/${serverId}/configs/${target}`,
          { signal: lifetime.signal },
        );
        if (selectedRef.current !== target) return;
        if (j.sha256 && serverShaRef.current && j.sha256 !== serverShaRef.current) {
          onExternalChange({ sha: j.sha256, content: j.content });
        }
      } catch (e) {
        if (isHardFailure(e)) stopped = true;
        // other errors are transient during polling
      }
    }
    const t = setInterval(poll, POLL_MS);
    return () => {
      lifetime.abort();
      clearInterval(t);
    };
  }, [serverId, selected, selectedRef, serverShaRef, onExternalChange]);
}
