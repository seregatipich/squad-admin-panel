# worker-discord — Troubleshooting

P2 stub. Container should idle without errors.

**Container restarting:** `docker compose logs worker-discord --since 5m`.

**Heartbeat absent:** Expected — the P2 stub does not publish a heartbeat.
