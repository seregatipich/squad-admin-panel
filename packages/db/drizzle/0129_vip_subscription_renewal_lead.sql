-- #364: a subscription now renews VIP_RENEWAL_LEAD before its role expires, so
-- the minute-granularity role-expiry tick can never strip the role ahead of the
-- hourly renewal tick. Bring subscriptions created under the old rule (billing
-- date equal to, or just after, the role expiry) onto the same schedule.
--
-- Rollback-safe: data only. The fix only moves active subscriptions' billing
-- date earlier.
UPDATE vip_subscriptions AS s
SET next_renewal_at = p.role_expires_at - interval '6 hours'
FROM players AS p, vip_tiers AS t
WHERE s.status = 'active'
  AND p.id = s.player_id
  AND t.id = s.tier_id
  AND p.role_id = t.role_id
  AND p.role_expires_at IS NOT NULL
  AND s.next_renewal_at > p.role_expires_at - interval '6 hours';
