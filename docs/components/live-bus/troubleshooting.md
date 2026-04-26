# `live-bus` — troubleshooting

## Symptom: WebSocket connects but no events arrive

**Diagnosis**:
1. Check the API log for `live-bus: redis subscribe failed; cross-process fan-out disabled` — Redis was unreachable at startup.
2. Confirm the producer fired: status-reconciler logs `reconciler: status updated` whenever it transitions; bridge-heartbeat logs `down:` / `recovered after` on edges.
3. Drive a publish manually and watch the socket:
   ```bash
   docker compose exec api node -e "
     const fetch = require('undici').fetch;
     /* publish a synthetic event by re-using a shell into the running process */
   "
   ```
   In practice, restart the API: `docker compose restart api` reattaches the Redis subscriber.

**Fix**: ensure `REDIS_URL` is reachable; `docker compose ps redis` shows `healthy`.

## Symptom: client gets disconnected with code 4000 every 30 s

**Cause**: the client is not replying with `{"type":"pong"}` to the server's `{"type":"ping"}` frames.

**Fix**: in the web client (Bundle F), wire:
```ts
ws.addEventListener('message', (msg) => {
  const evt = JSON.parse(msg.data);
  if (evt.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
});
```

## Symptom: "redis client lacks duplicate(); running in single-process mode" warning at startup

**Cause**: a test fixture or a misconfigured embedding decorated `app.redis` with an object that does not implement `duplicate()`.

**Fix in production**: ensure `redisPlugin` is registered before `liveBusPlugin` (it is, in `apps/api/src/server.ts`). If you see this in production, the registration order was changed — revert.

**Fix in tests**: this is expected; the plugin is designed to keep working. No action needed.

## Symptom: events delivered twice on a single replica

**Cause**: the originating replica's Redis subscriber sees its own publish and re-emits it locally — by design.

**Fix**: this is expected. UI updates are last-writer-wins on primitives (`status: 'running'`); double-delivery is a no-op visually. If a consumer needs idempotency over a non-idempotent op, dedupe by `(type, ts)` or by the `event_id` in the producer payload.

## Symptom: bridge banner stays red after `docker start panel-host-bridge`

**Diagnosis**:
1. Check API log for `recovered after Ns` — if absent, bridge-heartbeat is not yet seeing the bridge as up.
2. Bridge-heartbeat polls every 5 s; max 5 s extra latency on top of the normal recovery time.
3. Check the WS connection in the browser devtools Network tab — if the socket itself died (mid-restart of the API), the banner may be from `connection lost` not `bridge.connection: down`. Reload.

## Symptom: high listener-count warnings

**Cause**: a long-lived consumer (test or background) calls `liveBus.subscribe` without ever invoking the unsubscribe handle.

**Fix**: every subscriber MUST call its unsubscribe in a `finally`/`onClose`. The route at `apps/api/src/routes/live.ts` already does this. If you add a new consumer, mirror the pattern.

## Useful commands

```bash
# Tail Redis pub/sub on the live-bus channel from inside the redis container.
docker compose exec redis redis-cli SUBSCRIBE live-bus

# Tail the rcon edge channel.
docker compose exec redis redis-cli SUBSCRIBE rcon:status:changed

# Inspect the API log for live-bus warnings.
docker compose logs api --since 2m | grep -i live-bus
```

## Useful metrics

None today. If you add Prometheus metrics for the bus, suggested gauges:
- `live_bus_subscribers` — `emitter.listenerCount('event')`.
- `live_bus_publish_total{type=...}` — counter.
- `live_bus_redis_publish_failures_total` — counter; rising indicates Redis trouble.
