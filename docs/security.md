# Security model

## Threats we defend against

| Threat                                       | Mitigation                                                                  |
|----------------------------------------------|-----------------------------------------------------------------------------|
| Hostile Docker image / compromised container  | Bridge runs as root on the host; containers talk to it only via a unix socket restricted to the `panel` group. Whitelist validators reject anything outside policy. |
| Stolen session cookie                        | Opaque session IDs stored server-side, short TTL (8 h sliding, 30 d remember-me). Cookie is `__Host-`-prefixed (path/domain locked) and must be HTTPS-only. |
| Credential stuffing                          | Argon2id (OWASP 2024 params) + 5 login attempts per IP per 15 min rate limit. |
| 2FA bypass / token replay                    | TOTP validated via `@oslojs/otp`; we also record the last-used step and reject replays within the window. Backup codes are hashed with Argon2id and consumed on use. |
| Audit log tampering                          | DB triggers deny UPDATE/DELETE on `audit_log`, compute a SHA-256 hash chain, and serialize inserts via advisory lock. `scripts/verify-audit-chain.ts` validates the chain out-of-band. |
| Next.js middleware auth bypass (CVE-2025-29927) | Middleware never authorises. Real gate is server-side `requireSession()` inside `(dashboard)/layout.tsx`, using `react.cache()` for dedup. |
| Lateral movement into Squad data             | Every Squad server runs as the unprivileged `squad` user under systemd with `ProtectHome=read-only`, `PrivateUsers=yes`, tight `SystemCallFilter`, and an empty `CapabilityBoundingSet`. `systemd-analyze security` scores 1.3 OK. |
| SteamCMD-as-backdoor                         | Bridge rejects any steamcmd arg not in the whitelist; the install-dir token is regex-pinned to `/opt/squad-servers/{uuid}/`; login is anonymous-only; platform flag must precede login. |
| IP/Port enumeration from container           | Only the bridge binds the unix socket; worker-rcon uses `network_mode: host` to reach `127.0.0.1:{rcon_port}` which is itself unreachable externally (ufw allows only game/query/beacon). |

## Secrets

Secrets live in `.env` (bind-mounted read-only into compose). We never commit them.

- `POSTGRES_PASSWORD` — DB superuser
- `APP_ENCRYPTION_KEY` — 32-byte base64; decrypts `server_credentials.rcon_password_encrypted`, `server_credentials.license_key_encrypted`, `users.totp_secret_encrypted`. Losing this key breaks those decrypts; rotation bumps `key_version` and re-encrypts.
- `SESSION_SECRET` — used for Fastify cookie signing.

`APP_ENCRYPTION_KEY` storage upgrade path: the setup wizard emits the key once and asks the operator to save it outside the server. For large deployments we recommend SOPS+age for the full env file — documented in `docs/development.md`.

## TLS

Caddy terminates TLS. In dev (`TLS_ISSUER=internal`) it uses its internal CA so `admin.localhost` works out of the box. In prod (`TLS_ISSUER=acme`) it obtains a Let's Encrypt cert for `APP_DOMAIN` and renews automatically.

## Rate limiting

- Login: 5 attempts per IP per 15 min (`@fastify/rate-limit` keyed on IP).
- All API calls: 300 per minute per (IP, userId) pair. Static assets bypass the limiter.

## Attack surface inventory

- **Host → Docker boundary**: only the bridge socket (`/run/panel-host-bridge.sock`, 0660 `root:panel`) and the published ports 80/443.
- **Docker → Host boundary**: bridge socket (validated, whitelisted), `network_mode: host` for `worker-rcon` (127.0.0.1 only; no external listener).
- **API boundary**: Caddy TLS → `/api/*` + `/health` + `/metrics`. `/metrics` is un-auth but read-only and scraper-scoped.
- **Persistence**: PostgreSQL on an internal Docker network (never exposed).

## Regular hardening checks

- `pnpm audit --audit-level=high` — zero issues allowed.
- `govulncheck ./...` on the Go bridge.
- `systemd-analyze security panel-host-bridge` and `squad-server-<uuid>` — both must score < 3.0.
- `gitleaks protect --staged` on every pre-commit.
