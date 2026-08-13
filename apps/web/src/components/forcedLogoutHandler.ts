export interface ForcedLogoutDeps {
  /** Probes the current session; resolves to the `/api/v1/me` HTTP status. */
  fetchMe: () => Promise<{ status: number }>;
  /** Sends the tab to the login page. */
  redirect: () => void;
}

/**
 * Re-validates the current session after a `session.revoked` live-bus event and
 * forces this tab to the login page when the session is gone.
 *
 * The live-bus already targets events by `player_id`, so any `session.revoked`
 * received belongs to this player — but it may have been a *different* device
 * (e.g. "revoke another session" on the account page). We therefore probe
 * `GET /api/v1/me`: a `401` means *this* tab's session was invalidated (role
 * removed / panel access lost / revoke-all), so we redirect; any other status
 * (200 = another device revoked, 5xx = transient) leaves the tab untouched.
 * A network failure is swallowed — a later request or the account-page poll
 * will still catch a genuine revocation.
 */
export async function handleForcedLogout(deps: ForcedLogoutDeps): Promise<void> {
  let status: number;
  try {
    status = (await deps.fetchMe()).status;
  } catch {
    return;
  }
  if (status === 401) deps.redirect();
}
