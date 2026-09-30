#!/usr/bin/env bash
# verify-bridge.sh — smoke-test the running panel-host-bridge.
#
# Sends one length-prefixed JSON frame per probe and asserts the reply:
#   ok                 the call must succeed (the reply is printed);
#   forbidden[:TEXT]   the call must be refused with error code "forbidden"
#                      (and, when TEXT is given, a message containing TEXT).
# Any other reply stops the script with a non-zero exit. A negative probe that
# unexpectedly succeeds never has its body printed, so an allowlist regression
# cannot leak host files such as /etc/shadow into the terminal.
#
# This is a post-deploy smoke test of the privilege boundary, not coverage of
# every RPC: the per-method contracts live in apps/bridge's Go tests.

set -euo pipefail

SOCKET="${BRIDGE_SOCKET:-/run/panel-host-bridge/bridge.sock}"

die() { printf '\033[31m[verify-bridge]\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[32m[verify-bridge]\033[0m %s\n' "$*"; }

[[ -S "$SOCKET" ]] || die "socket $SOCKET not found — is panel-host-bridge running?"
command -v python3 >/dev/null || die "python3 required for framing helper"

# call ID METHOD PARAMS EXPECT [TIMEOUT]
call() {
  local id="$1"
  local method="$2"
  local params="$3"
  local expect="$4"
  local timeout="${5:-10}"
  log "→ $method (expect $expect)"
  BRIDGE_SOCKET="$SOCKET" REQ_ID="$id" REQ_METHOD="$method" REQ_PARAMS="$params" \
    REQ_EXPECT="$expect" REQ_TIMEOUT="$timeout" python3 - <<'PY'
import json, os, socket, struct, sys

sock_path = os.environ['BRIDGE_SOCKET']
method = os.environ['REQ_METHOD']
expect = os.environ['REQ_EXPECT']
req = {'id': os.environ['REQ_ID'], 'method': method, 'params': json.loads(os.environ['REQ_PARAMS'])}
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

def fail(reason):
    print(f'[verify-bridge] {method}: {reason}', file=sys.stderr)
    sys.exit(1)

hdr = recvn(4)
if len(hdr) < 4:
    print('(no response)', file=sys.stderr)
    sys.exit(1)
size = struct.unpack('>I', hdr)[0]
body = recvn(size)
s.close()
reply = json.loads(body.decode('utf-8'))
error = reply.get('error') if isinstance(reply.get('error'), dict) else None
code = error.get('code') if error else None
message = str(error.get('message', '')) if error else ''

if expect == 'ok':
    if reply.get('ok') is not True or error:
        fail(f'expected ok, got error code={code!r} message={message!r}')
    print(json.dumps(reply, indent=2))
    sys.exit(0)

wanted_code, _, wanted_text = expect.partition(':')
if reply.get('ok') is True or code != wanted_code:
    # The body of an unexpected success is withheld on purpose: it may hold
    # the very data the allowlist exists to protect.
    fail(f'expected a {wanted_code} refusal, got ok={reply.get("ok")!r} code={code!r}')
if wanted_text and wanted_text not in message:
    fail(f'refused by the wrong rule: expected a message containing {wanted_text!r}, got {message!r}')
print(json.dumps({'ok': False, 'error': {'code': code, 'message': message}}, indent=2))
PY
  echo
}

call 'verify-1' 'ping' 'null' ok
call 'verify-2' 'host_info' 'null' ok
call 'verify-3' 'host_metrics' 'null' ok
call 'verify-4' 'list_panel_dirs' 'null' ok
# Path allowlist: a system file outside every permitted root.
call 'verify-5' 'file_read' '{"path": "/etc/shadow"}' forbidden
call 'verify-6' 'file_atomic_write' '{"path": "/opt/squad-servers/verify-bridge.tmp", "content": "verify-bridge ok\n", "mode": 420}' forbidden
# A well-formed name of a container that does not exist resolves to state not_found.
call 'verify-7' 'container_inspect' '{"name": "squad-00000000-0000-0000-0000-000000000000"}' ok
# Image allowlist: the server_id is valid so the image is the rule that refuses
# it; even if that rule regressed, the missing mounts are refused next, so the
# probe never starts a container.
call 'verify-8' 'container_run' '{"server_id": "00000000-0000-0000-0000-000000000000", "image": "alpine:latest"}' 'forbidden:not in allowlist'

log "done."
