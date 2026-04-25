# worker-automation — Troubleshooting

P2 stub. The container runs a simple loop and should not crash.

**Container restarting:** Check logs with `docker compose logs worker-automation --since 5m`. The only fatal path is an uncaught rejection in `main()`.

**Heartbeat absent from `/api/v1/health/workers`:** Expected — the P2 stub does not call `startHeartbeat`. The worker will not appear in the health endpoint until Phase 2 implementation.
