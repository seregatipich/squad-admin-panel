#!/usr/bin/env bash
# verify-bridge.sh — smoke-test the running panel-host-bridge via nc.
# Builds a length-prefixed JSON frame for each method and prints the reply.

set -euo pipefail

SOCKET="${BRIDGE_SOCKET:-/run/panel-host-bridge.sock}"

die() { printf '\033[31m[verify-bridge]\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[32m[verify-bridge]\033[0m %s\n' "$*"; }

[[ -S "$SOCKET" ]] || die "socket $SOCKET not found — is panel-host-bridge running?"
command -v nc >/dev/null || die "nc (netcat) required; install with: apt-get install -y netcat-openbsd"
command -v python3 >/dev/null || die "python3 required for framing helper"

frame() {
  local json="$1"
  python3 - "$json" <<'PY'
import sys, struct
payload = sys.argv[1].encode('utf-8')
sys.stdout.buffer.write(struct.pack('>I', len(payload)) + payload)
PY
}

call() {
  local id="$1"; shift
  local method="$1"; shift
  local params="${1:-null}"
  local req
  req=$(python3 -c "import json,sys; print(json.dumps({'id': sys.argv[1], 'method': sys.argv[2], 'params': json.loads(sys.argv[3])}))" "$id" "$method" "$params")
  log "→ $method"
  frame "$req" | nc -q 1 -U "$SOCKET" | python3 - <<'PY'
import sys, struct, json
buf = sys.stdin.buffer.read()
offset = 0
while offset + 4 <= len(buf):
    size = struct.unpack('>I', buf[offset:offset+4])[0]
    body = buf[offset+4:offset+4+size]
    try:
        obj = json.loads(body.decode('utf-8'))
        print(json.dumps(obj, indent=2))
    except Exception as e:
        print(f"(decode failed: {e})")
    offset += 4 + size
PY
  echo
}

call 'verify-1' 'ping' 'null'
call 'verify-2' 'host_info' 'null'
call 'verify-3' 'systemctl_action' '{"unit": "nginx.service", "action": "start"}'     # must be forbidden
call 'verify-4' 'apt_install' '{"packages": ["bash"]}'                                  # must be forbidden
call 'verify-5' 'apt_install' '{"packages": ["curl"]}'
call 'verify-6' 'file_read' '{"path": "/etc/shadow"}'                                   # must be forbidden

log "done."
