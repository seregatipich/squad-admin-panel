# Troubleshooting

## `docker compose up -d` starts but /setup never loads

1. `docker compose ps` — every container should be `healthy` (takes up to 2 min).
2. If `api` is unhealthy, `docker compose logs api | tail -40` usually says why. Most common causes:
   - `APP_ENCRYPTION_KEY` missing or < 32 bytes.
   - `DATABASE_URL` / `REDIS_URL` unreachable (check postgres / redis health first).
3. `curl -k https://admin.localhost/health` should return `{"status":"ok"}`.

## SteamCMD fails with "Missing configuration"

That means the platform override is missing or misordered. Verify the installed bridge rejects it by running `scripts/verify-bridge.sh` — you should see one of the probe calls (passing a bad install-dir) come back with `"code":"forbidden"`. The panel's install wizard constructs the arguments correctly; hand-crafted calls must put `+@sSteamCmdForcePlatformType linux` **before** `+login`.

## "bridge: disconnected" banner in the dashboard

1. On the host: `systemctl status panel-host-bridge.socket`. It should be `active (listening)`.
2. `sudo -u node /app/apps/api scripts/... ` — check that the node user (inside the container) can actually connect. The socket is `0660 root:panel`; the user or the container must be in the `panel` group.
3. `systemctl restart panel-host-bridge.socket panel-host-bridge.service`.

## Squad server doesn't appear in the Steam Server Browser

Verified in §0A.8 experiment findings: Squad v10 does **not** respond to A2S queries. Visibility in the Steam Server Browser → Community Servers list depends on the server's EOS session being reachable publicly. Things to check:

- The host has a public IP (not behind CGNAT).
- `Server.cfg` has `ShouldAdvertise=true` (default).
- `IsLANMatch=false` (default).
- UFW allows game/query/beacon ports — `ufw status` on the host.
- Give it 1–3 minutes after `Start`; first registration with EOS takes a moment.

## "This user doesn't exist" — but it does

The email lookup is case-insensitive (`lower(email) UNIQUE`). If you signed up as `USER@example.com` but are trying to login as `user@example.com`, both work. If neither does, double-check the DB: `SELECT id, email FROM users WHERE lower(email) = lower('…');`

## 2FA is required but you lost the phone and the backup codes

Because codes + TOTP secret are Argon2id-hashed and AES-256-GCM encrypted respectively, panel cannot recover them for you. Recovery is a DB-level operation:

```sql
UPDATE users
   SET totp_secret_encrypted = NULL,
       totp_backup_codes_hash = NULL,
       totp_last_used_step = NULL
 WHERE id = (SELECT id FROM users WHERE lower(email) = lower('owner@example.com'));
```

(Requires the Owner or someone with direct DB access; left un-exposed via API by design.)

## Audit log ever shows a gap or hash mismatch

`pnpm verify:audit-chain` exits non-zero with the first broken row. Treat it as an incident:

1. `SELECT * FROM audit_log WHERE id = <broken id - 5> AND id <= <broken id + 5>;`
2. Check the DB host for unauthorised access (pg_dump timestamps, `SELECT usename,state FROM pg_stat_activity`).
3. Restore `audit_log` from backup (the restic sidecar keeps daily snapshots); a mismatch past the last-good commit means the chain really was tampered with.

The triggers prevent application-level tampering; only a superuser with raw DB access can modify these rows, and even then the chain will break on verify.
