#!/usr/bin/env bash
# verify-bridge.sh — smoke-test the running panel-host-bridge via nc.
# Builds a length-prefixed JSON frame for each method and prints the reply.

set -euo pipefail

SOCKET="${BRIDGE_SOCKET:-/run/panel-host-bridge.sock}"

die() { printf '\033[31m[verify-bridge]\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[32m[verify-bridge]\033[0m %s\n' "$*"; }

[[ -S "$SOCKET" ]] || die "socket $SOCKET not found — is panel-host-bridge running?"
command -v python3 >/dev/null || die "python3 required for framing helper"

call() {
  local id="$1"
  local method="$2"
  local params="${3:-null}"
  local timeout="${4:-10}"
  log "→ $method"
  BRIDGE_SOCKET="$SOCKET" REQ_ID="$id" REQ_METHOD="$method" REQ_PARAMS="$params" REQ_TIMEOUT="$timeout" python3 - <<'PY'
import json, os, socket, struct, sys

sock_path = os.environ['BRIDGE_SOCKET']
req = {'id': os.environ['REQ_ID'], 'method': os.environ['REQ_METHOD'], 'params': json.loads(os.environ['REQ_PARAMS'])}
payload = json.dumps(req).encode('utf-8')

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(int(os.environ.get('REQ_TIMEOUT', '10')))
s.connect(sock_path)
s.sendall(struct.pack('>I', len(payload)) + payload)

def recvn(n):
    buf = b''
    while len(buf) < n:
        chunk = s.recv(n - len(buf))
        if not chunk:
            break
        buf += chunk
    return buf

hdr = recvn(4)
if len(hdr) < 4:
    print('(no response)', file=sys.stderr)
    sys.exit(1)
size = struct.unpack('>I', hdr)[0]
body = recvn(size)
print(json.dumps(json.loads(body.decode('utf-8')), indent=2))
s.close()
PY
  echo
}

call 'verify-1' 'ping' 'null'
call 'verify-2' 'host_info' 'null'
call 'verify-3' 'host_metrics' 'null'
call 'verify-4' 'process_info' "{\"pid\": $$}"
call 'verify-5' 'file_read' '{"path": "/etc/shadow"}'                                   # must be forbidden (path allowlist)
call 'verify-6' 'file_atomic_write' '{"path": "/opt/squad-servers/verify-bridge.tmp", "content": "verify-bridge ok\n", "mode": 420}'   # must be forbidden
call 'verify-7' 'container_inspect' '{"name": "squad-00000000-0000-0000-0000-000000000000"}'   # must resolve (missing container)
call 'verify-8' 'container_run' '{"name": "squad-00000000-0000-0000-0000-000000000000", "image": "alpine:latest", "networkMode": "host"}'   # must be forbidden (image allowlist)

log "done."
