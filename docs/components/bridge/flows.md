# `bridge` — flows

## Install a Squad server (bridge view)

```
api ──container_inspect──▶ bridge ──exec docker inspect squad-depot──▶ docker
api ──depot_update──────▶ bridge ──run squad-panel/depot-init container──▶ docker
                            ◀── stream stdout ('downloading', 'validating', ...)
                            ◀── final {ok, exit_code: 0}
api ──ufw_rule add×4────▶ bridge ──exec ufw allow <port>/<proto>──▶ ufw
api ──container_run─────▶ bridge ──exec docker run -d ...──▶ docker
                            ◀── {ok, container_id}
status-reconciler:
  every 4 s:
api ──container_inspect──▶ bridge → {state: running}
```

## Live config edit

```
ui PUT /servers/:id/configs/Admins.cfg
api: validate body, sha256 (no-op short-circuit)
api ──file_atomic_write──▶ bridge:
                              validate path against allowlist
                              write Admins.cfg.new
                              fsync
                              rename Admins.cfg → Admins.cfg.bak
                              rename Admins.cfg.new → Admins.cfg
                            ◀── {status: 'written'}
api: INSERT config_versions (author_id, message, sha256, content)
     audit-log row
     invalidate Redis blame cache for the previous tip
```

Squad re-reads `Admins.cfg`, `Bans.cfg`, `RemoteAdminListHosts.cfg`, and `RemoteBanListHosts.cfg` live; everything else under `ALLOWED_CONFIG_FILES` requires a container restart to take effect.

## Live log streaming

```
ui opens /servers/:id/logs WebSocket
api: app.makeBridgeClient() — dedicated bridge connection per socket
api ──container_logs_follow──▶ bridge ──exec docker logs -f squad-{uuid}──▶ docker
                                 ◀── stream chunks
api forwards chunks as WS frames
ui closed → api closes the dedicated bridge connection → bridge tears down docker logs subprocess
```

The dedicated-connection pattern matters: `app.bridge` (singleton) starves sibling calls if a long log-follow holds the multiplex.

## Stop and remove

```
api: rcon AdminBroadcast 'Server is shutting down…'
api: rcon AdminEndMatch
api ──container_stop──▶ bridge:
                          docker stop -t 30 squad-{uuid}
                            (SIGTERM → wait → SIGKILL after timeout)
                        ◀── {status: 'stopped'}
status-reconciler picks up `exited` state, sets servers.status = 'stopped'
worker-rcon drops the target on next reconcile
DELETE /servers/:id:
api ──container_rm──▶ bridge: docker rm squad-{uuid}
api ──ufw_rule delete×4──▶ bridge
api: DELETE servers WHERE id=$1
     bind-mounted dirs under /var/lib/squad-panel/{configs,saved}/{uuid}/ retained by default
```

## Decode error / connection loss

The bridge-client decode-error path **does not** set `closed=true` on the client — dropping the socket and letting the next call reconnect is correct. Permanently closing wedges every subsequent caller. See [`packages/bridge-client/src/client.ts` `attachHandlers`](../../../packages/bridge-client/src/client.ts).
