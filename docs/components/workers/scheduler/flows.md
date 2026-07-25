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
5. AUTO-2 scheduled tasks: for each due row, dispatch the action (restart via the
   SRV-3 container boundary, or an `AdminSetNextLayer`/`AdminChangeLayer`/
   `AdminBroadcast` RCON command). For a `broadcast` (MSG-4), resolve the text at
   `params.messages[rotation_index]` (falling back to the single `params.message`),
   then after a successful dispatch advance `rotation_index` (only when the list
   has more than one entry) and echo the text into `chat_messages` when the task
   has a creator. Depot-window overlap skips without advancing any cursor; a
   dispatch throw records a `failed` run and likewise leaves cursors unchanged.
6. On SIGTERM/SIGINT, stop the interval, publish shutdown diagnostics, close
   the bridge, and close Postgres/Redis connections.
