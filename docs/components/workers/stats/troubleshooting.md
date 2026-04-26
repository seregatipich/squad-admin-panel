# worker-stats — Troubleshooting

P2 stub. Container should idle without errors.

**Container restarting:** `docker compose logs worker-stats --since 5m`.

**Heartbeat absent:** Expected — the P2 stub does not publish a heartbeat.
