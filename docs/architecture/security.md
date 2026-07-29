# Security model

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| Hostile container / compromised image | The bridge is the only path to root, and its socket is `0660 root:panel`. `SO_PEERCRED` + primary-GID check rejects callers outside the `panel` group. Every RPC method runs through a whitelist validator (paths, image names, container-name regex, ufw action/port/proto). The two allowed Docker images are `squad-server:latest` and `squad-panel/depot-init:latest`. |
| Stolen session cookie | Opaque server-side session IDs with sliding 6 h TTL (configurable via `SESSION_TTL_SECONDS`). Cookie is `__Host-sid`: `Secure; HttpOnly; SameSite=lax; Path=/`, no domain attribute. Session touch is throttled to one DB write per 60 s (`SESSION_TOUCH_THROTTLE_SECONDS`) via Redis `SETNX`. |
| Audit log tampering | DB trigger rejects `UPDATE`/`DELETE` on `audit_log`. Each row stores `row_hash = sha256(prev_hash || canonical_json(row))`. Inserts are serialized via advisory lock. `pnpm verify:audit-chain` validates the chain out-of-band; `audit_log.id` is `bigserial` (always serialize as `String(...)` to JSON). |
| Next.js middleware auth bypass (CVE-2025-29927) | Middleware never authorises. Real auth gate is server-side `requireSession()` inside `(dashboard)/layout.tsx`, deduped via `react.cache()`. |
| A VIP self-service login reaching the panel (VIPSUB-5) | A Steam login whose role has no `panel_access` gets a session with `sessions.scope = 'self_service'`. `apps/api/src/plugins/auth.ts` honours that scope **only** on routes that opt in with `config.selfService`, and drops `req.user`/`req.session` everywhere else, so the request is anonymous and answers 401. Deny-by-default is required rather than checking the permission set, because `loadUserPermissions` layers explicit `role_permissions` rows on top of the derived set, ~30 routes authorise on `req.user` alone (`issues.ts`, `message-templates.ts`, `banned-names.ts`) and the `squadPermissions` guards are not gated on `panel_access`. Proven by [`apps/api/test/security/self-service-session.test.ts`](../../apps/api/test/security/self-service-session.test.ts). |
| Container escape into other servers | Each Squad container runs `--user 1001:1001 --read-only` with two RW bind mounts (its own `ServerConfig/` and `Saved/`). The depot volume is shared but mounted `:ro`. Containers do not share `/run`, `/tmp`, or volumes other than the bridge socket. |
| Steam-CDN-as-backdoor | The bridge `depot_update` call uses a transient `squad-panel/depot-init` container with steamcmd args composed inside the bridge — callers can't inject arbitrary tokens. The container is removed on completion. |
| Lateral movement to RCON | RCON ports are only on `127.0.0.1`; ufw rules opened by `bridge.ufw_rule` are for game/query/beacon. RCON traffic stays on the loopback, reachable only from the host (and `worker-rcon` via `--network host`). |
| Untrusted/PR code executing on the self-hosted CI runner | `.github/workflows/ci.yml` triggers only on trusted `push` (`master`/`dev`) and `workflow_dispatch` events — never `pull_request` or `pull_request_target` — so no job with `runs-on: self-hosted` ever checks out and executes a pull request's head before human review. `scripts/test-workflow-security.sh` statically rejects any workflow file that combines a `pull_request`/`pull_request_target` trigger with `runs-on: self-hosted`, and runs as a `branch-guard` step on every push (#217). |
| Fail-open permission default (#246) | The global `onRequest` hook (`apps/api/src/plugins/auth.ts`) used to return early whenever a route declared no `config.permissions`, treating "nobody added permissions" as "public". `GET /api/docs*` (the full OpenAPI schema) and `GET /api/v1/host/bridge-status` shipped to production unauthenticated this way; auditing every route/plugin file found three more live instances (`/api/v1/health/workers`, `/api/v1/health/reconciler`, `integrations-balancer.ts`, `integrations-vip.ts`). The hook is now fail-closed: a route requires a session unless it declares `config.public: true`, a small reviewed allowlist (health/readiness probes, `/metrics`, signature-gated webhooks, public data portals, pre-login Steam OAuth). Proven by [`apps/api/test/security/fail-open-default.test.ts`](../../apps/api/test/security/fail-open-default.test.ts). |

## Trust boundaries

- **Browser → Caddy**: TLS terminates at Caddy.
- **Caddy → web/api containers**: Docker bridge network, only ports 80/443 are published.
- **Containers → bridge**: unix socket bind-mounted into containers that need it (api, worker-rcon, worker-log-ingest). Group membership (`panel`) is checked on every connection.
- **Bridge → host**: bridge runs as root with `CAP_NET_ADMIN` (for `ufw`). All file paths are allowlisted under `/var/lib/squad-panel/configs/{uuid}/ServerConfig/*.cfg`, `/var/lib/squad-panel/saved/{uuid}/**`, and `/var/lib/docker/volumes/squad-depot/**` (RO).

## systemd-analyze score

`systemd-analyze security panel-host-bridge.service` target is **< 3.0**. Current score is **2.0 OK** with only `CAP_NET_ADMIN` remaining (needed for `ufw`). The unit at [`apps/bridge/deploy/panel-host-bridge.service`](../../apps/bridge/deploy/panel-host-bridge.service) sets `ProtectHome=yes`, which means the bridge cannot read `/root/`. Harmless docker-CLI warnings about `/root/.docker/config.json` are expected.

## Secrets

Secrets live in `.env`, bind-mounted read-only into compose. Never commit them.

| Variable | Purpose | Rotation |
|---|---|---|
| `POSTGRES_PASSWORD` | DB superuser | Restart DB + api after rotating; existing sessions stay valid. |
| `APP_ENCRYPTION_KEY` | 32-byte base64. Decrypts `server_credentials.rcon_password_encrypted`, `server_credentials.license_key_encrypted`. **Losing it breaks those decrypts.** | Bumps `key_version` and re-encrypts. Generate with `openssl rand -base64 32` and store offline — the panel never re-displays it. |
| `SESSION_SECRET` | Fastify cookie signing | Rotating invalidates existing sessions. |

For multi-host or compliance-sensitive deployments, store the full `.env` with SOPS+age (referenced in [`development/local-development.md`](../development/local-development.md)).

## TLS

Caddy terminates TLS. `TLS_ISSUER=internal` uses Caddy's internal CA so `admin.localhost` works in dev; `TLS_ISSUER=acme` obtains a Let's Encrypt cert for `APP_DOMAIN` and renews automatically.

## Rate limiting

- Steam callback: rate-limited by IP to guard against nonce-stuffing.
- All API calls: 300 / minute per `(IP, steamId64)` pair. Static assets bypass the limiter.

## Attack surface inventory

- **Public**: 80/443 (Caddy → web, api).
- **Container ↔ host**: bridge unix socket only.
- **Persistence**: PostgreSQL on the internal compose network, never exposed publicly.
- **Per-server**: game/query/beacon UDP ports + RCON TCP. UFW only opens game/query/beacon publicly; RCON stays on `127.0.0.1`.

## Regular hardening checks

- Dependabot alerts are tracked centrally (see #213) and worked down in remediation waves; there is currently no blocking `pnpm audit` step in CI.
- `govulncheck ./...` on the Go bridge (CI).
- `systemd-analyze security panel-host-bridge` — must score < 3.0.
- `gitleaks protect --staged` on every pre-commit (Lefthook hook; warns if the binary is missing).
