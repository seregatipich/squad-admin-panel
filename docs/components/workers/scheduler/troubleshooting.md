# worker-scheduler — Troubleshooting

The scheduler requires Postgres, Redis, and the host bridge socket. Check all
three dependencies before investigating application errors.

**Container restarting:** `docker compose logs worker-scheduler --since 5m`.

**Heartbeat absent:** inspect `docker compose logs worker-scheduler --since 5m`
and verify `REDIS_URL` plus Redis availability.

**Profile application fails:** verify `PANEL_BRIDGE_SOCKET` is mounted in the
container and that the worker's primary group matches the bridge trust group.
