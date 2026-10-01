'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/api';
import { type Member, type MembersResponse, PAGE_SIZE } from './members-shared';

/**
 * State of the role's member list: the current page, its search text and
 * offset, the load error and the selection of rows.
 *
 * @param roleId Role whose members are listed.
 * @returns The page data (`null` until the first response), setters for the
 *   search text and offset, `load` to refetch the current page, and the
 *   row-selection helpers. A new page replaces the selection.
 */
export function useRoleMembers(roleId: string) {
  const [data, setData] = useState<MembersResponse | null>(null);
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const latestLoad = useRef(0);

  /** Loads the current page; a response that is no longer the latest request is dropped. */
  const load = useCallback(async () => {
    const requestId = ++latestLoad.current;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (q.trim()) params.set('q', q.trim());
    try {
      const body = await apiFetch<MembersResponse>(`/api/v1/roles/${roleId}/members?${params}`);
      if (requestId !== latestLoad.current) return;
      setSelected(new Set());
      setData(body);
    } catch (e) {
      if (requestId !== latestLoad.current) return;
      setErr(e instanceof ApiError ? `HTTP ${e.status}` : 'Сетевая ошибка');
    }
  }, [roleId, offset, q]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleOne(playerId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  }

  function toggleAll(items: Member[]) {
    setSelected((prev) => {
      const allSelected = items.length > 0 && items.every((m) => prev.has(m.id));
      return allSelected ? new Set() : new Set(items.map((m) => m.id));
    });
  }

  return { data, q, setQ, offset, setOffset, err, setErr, selected, load, toggleOne, toggleAll };
}
