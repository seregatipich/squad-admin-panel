# worker-automation — Flows

P2 stub. Current flow:

1. Log `"worker-automation idle — deferred to later phase"`.
2. Set 60 s interval to log `debug: heartbeat`.
3. On SIGTERM/SIGINT: clear interval, `process.exit(0)`.
