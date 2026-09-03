# `api` — configuration

## Environment variables

| Name | Required | Default | Environment | Description | Sensitive |
|---|---:|---|---|---|---|
| `DATABASE_URL` | yes | — | all | Postgres URL. | yes |
| `REDIS_URL` | yes | `redis://redis:6379` | all | Redis URL. | no |
| `BRIDGE_SOCKET` | yes | `/run/panel-host-bridge/bridge.sock` | all | Path to the bridge unix socket. | no |
| `APP_DOMAIN` | yes | `admin.localhost` | all | FQDN under which Caddy serves the panel. Used for CSRF/cookie/redirect URLs. | no |
| `PANEL_PUBLIC_URL` | yes | — | all | Full public URL of the panel (e.g. `https://panel.example`). Used as the `openid.return_to` and `openid.realm` base for Steam OpenID callbacks. | no |
| `APP_ENCRYPTION_KEY` | yes | — | all | 32-byte base64. AES-256-GCM key for `server_credentials.*_encrypted`. | yes |
| `SESSION_SECRET` | yes | — | all | Cookie-signing secret. | yes |
| `VIP_LIFECYCLE_WEBHOOK_SECRET` | нет | — | все | Общий HMAC-ключ для выключенных по умолчанию VIP preflight, lifecycle и status. Timestamp каждого запроса обязан попасть в окно ±300 секунд. | да |
| `VIP_LIFECYCLE_REQUIRE_REVISION` | нет | `false` | все | Желаемый режим запуска: после совместимого выпуска сайта требует положительную `revision` и точный UUID `vip_tiers.id` в `tier`. Durable-флаг PostgreSQL не снимается значением `false`; для отката нужна отдельная операторская команда. | нет |
| `BALANCER_WEBHOOK_SECRET` | no | — | all | HMAC secret for the disabled-by-default team-balancer proposal endpoint. Shared with the SquadJS balancer exporter. Ingestion only — the panel never executes a team change. | yes |
| `STEAM_API_KEY` | no | — | all | Steam Web API key for persona/avatar enrichment. Without it, persona falls back to `Player <last 4 of steam_id64>`. Get from https://steamcommunity.com/dev/apikey | yes |
| `SESSION_TTL_SECONDS` | no | `21600` (6 h) | all | Sliding session lifetime in seconds. | no |
| `SESSION_TOUCH_THROTTLE_SECONDS` | no | `60` | all | Minimum interval between DB session-touch writes per session (Redis `SETNX session-touch:{id}`). | no |
| `GLITCHTIP_DSN` | no | — | all | Sentry-compatible error reporting. | yes |
| `LOG_LEVEL` | no | `info` | all | `pino` log level. | no |
| `NODE_ENV` | no | `development` | all | `production` disables pretty logs. Swagger UI is still registered at `/api/docs`. | no |

## Listening port

Inside the container the API binds `0.0.0.0:3000`. Caddy proxies `/api/*` and the WebSocket upgrade routes to that port over the internal compose network.

## Порядок включения VIP lifecycle

1. Выпустить миграции, API и `worker-config-sync` с
   `VIP_LIFECYCLE_REQUIRE_REVISION=false`.
2. Выпустить сайт, который проверяет точную пару UUID tier↔role через
   `/api/v1/integrations/vip/tier-role`, сохраняет возвращённый `tier_code` в
   операции доставки, передаёт положительную revision, обрабатывает конфликты
   `event_body_conflict`, `revision_conflict` и `tier_role_mismatch` и опрашивает
   status после `202`.
3. Ручным `vip-revision-cutover` включить строгий режим. Команда под единым
   advisory lock проверяет ownership и атомарно ставит
   `panel_meta.vip_lifecycle_strict=true`, после чего перезапускает API с
   `VIP_LIFECYCLE_REQUIRE_REVISION=true` и выполняет подписанный smoke.

Запуск с env=`false` при уже включённом durable-флаге завершается ошибкой и не
ослабляет границу. Снятие разрешено только явной rollback-веткой cutover после
остановки API. Откат сайта безопасен только после этой контролируемой операции.
Каждый запуск API и cutover-аудит fail-closed сверяют точный состав DB-fence:
владельца, язык, режим и SHA-256 тела обеих функций, а также таблицу,
события, колонки, функцию и `ENABLED` каждого trigger. Удалённое, выключенное,
перепривязанное или изменённое ограждение блокирует запуск до открытия HTTP.

## Plugin tunables

These are not env-driven; change in code if needed.

- `@fastify/rate-limit`: 1200 req/min per `(IP, playerId)`. Steam callback is IP-keyed before a user context exists.
- Cookie session TTL: 6 h sliding (configurable via `SESSION_TTL_SECONDS`). Touch throttled to one DB write per 60 s (`SESSION_TOUCH_THROTTLE_SECONDS`).
- `status-reconciler` poll interval: 4 s (`RECONCILE_INTERVAL_MS` in [`status-reconciler.ts`](../../../apps/api/src/plugins/status-reconciler.ts)). The first tick fires on `onReady`, then every 4 s. Lower means faster UI feedback, more `container_inspect` load.
- `status-reconciler` per-tick budget: 12 s (`TICK_BUDGET_MS`). `Promise.allSettled` across all transient servers races against a timer of this length. Servers that don't finish before budget retry on the next interval. `last_tick_budget_exceeded` in the health endpoint flags when this kicked in.
- `status-reconciler` stale-install watchdog: 30 min (`STALE_INSTALL_AFTER_MS`). A row in `status='installing'` with `updated_at` older than this threshold is auto-flipped to `failed` on the next tick. Tune up if you have intentional long-running installs (e.g. depot_update on a slow link).
- `status-reconciler` stuck threshold: 90 s (`STUCK_AFTER_MS`). Rows in `starting`/`stopping`/`installing` older than this surface in `GET /api/v1/health/reconciler` `stuck_servers[]`.
- `status-reconciler` failure-log cadence: per-server consecutive `container_inspect` errors are silent on attempt 1 (debug), then `warn` on attempt 5, 30, and every 60th. The map is pruned on success and when the row leaves a transient state.
- `status-reconciler` watched statuses: `starting`, `stopping`, `running`, `stopped`, `ready`. `installing` (owned by install-progress) and `failed` (operator-cleared) are intentionally excluded from the docker→DB mapping. The watchdog handles `installing` separately.
- Blame cache TTL in Redis: 24 h.

## See also

- [`docs/operations/environment-variables.md`](../../operations/environment-variables.md) for the full project-wide table.
