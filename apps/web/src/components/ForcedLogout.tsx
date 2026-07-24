'use client';

import { useCallback } from 'react';
import type { LiveEvent } from '@/lib/live-bus';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { handleForcedLogout } from './forcedLogout';

type SessionRevokedEvent = Extract<LiveEvent, { type: 'session.revoked' }>;

/**
 * Global forced-logout listener. Mounted once in the dashboard layout so that,
 * on any page, a server-side session revoke (role removed, panel access lost,
 * revoke-all) pushed over the live bus logs this tab out within ≤5 s instead of
 * only being noticed on the next request or the 30 s account-page poll.
 */
export function ForcedLogout() {
  const onRevoked = useCallback((_event: SessionRevokedEvent) => {
    void handleForcedLogout({
      fetchMe: () => fetch('/api/v1/me', { credentials: 'include', cache: 'no-store' }),
      redirect: () => {
        window.location.href = '/login';
      },
    });
  }, []);
  useLiveSubscription('session.revoked', onRevoked);

  return null;
}
