# worker-scheduler — Flows

1. Connect to Postgres, Redis, and the host bridge, then publish the scheduler
   heartbeat.
2. On each tick, run the seed schedule, one-off rotation schedule, and weekly
   profile ticks concurrently.
3. Due one-off rotations are skipped while `depot:updating` is set; otherwise
   the selected RCON command is queued and the execution cursor/audit row is
   written.
4. At the configured server-local hour, choose the weekday profile or default,
   replace only the ROT-2 managed segment, and write the application cursor and
   audit row.
5. On SIGTERM/SIGINT, stop the interval, publish shutdown diagnostics, close
   the bridge, and close Postgres/Redis connections.
