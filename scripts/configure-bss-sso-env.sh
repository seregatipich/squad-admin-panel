#!/usr/bin/env bash
# Атомарно записать боевые настройки единого входа, получив секрет только через stdin.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/squad-admin-panel}"
ENV_FILE="$APP_DIR/.env.tk104"

if [[ ! -f "$ENV_FILE" || -L "$ENV_FILE" ]]; then
  echo "fatal: production environment file is missing or unsafe" >&2
  exit 1
fi

shared_secret=''
if IFS= read -r shared_secret; then
  echo "fatal: BSS SSO shared secret must be an exact unterminated line" >&2
  exit 1
fi
if (( ${#shared_secret} < 32 || ${#shared_secret} > 512 )) || [[ "$shared_secret" =~ [[:space:]] ]]; then
  echo "fatal: BSS SSO shared secret is invalid" >&2
  exit 1
fi

python3 - "$ENV_FILE" 3<<<"$shared_secret" <<'PY'
from __future__ import annotations

import hashlib
import hmac
import os
import re
import stat
import sys
import tempfile
from pathlib import Path

path = Path(sys.argv[1])
metadata = path.lstat()
if not stat.S_ISREG(metadata.st_mode):
    raise SystemExit("fatal: production environment file is not regular")

secret = os.fdopen(3, encoding="utf-8").read().removesuffix("\n")
if not 32 <= len(secret) <= 512 or any(character.isspace() for character in secret):
    raise SystemExit("fatal: BSS SSO shared secret is invalid")

desired_revision = os.environ.get("VIP_LIFECYCLE_REQUIRE_REVISION_DESIRED", "")
if desired_revision not in {"", "true", "false"}:
    raise SystemExit("fatal: VIP lifecycle revision mode is invalid")
desired_release_sha = os.environ.get("PANEL_RELEASE_SHA_DESIRED", "")
if desired_release_sha and re.fullmatch(r"[0-9a-f]{40}", desired_release_sha) is None:
    raise SystemExit("fatal: panel release SHA is invalid")
verify_only = os.environ.get("BSS_SSO_ENV_VERIFY_ONLY", "")
if verify_only not in {"", "true"}:
    raise SystemExit("fatal: BSS SSO environment verification mode is invalid")

key_pattern = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
source = path.read_text(encoding="utf-8")
values: dict[str, str] = {}
for raw_line in source.splitlines():
    if not raw_line.strip() or raw_line.lstrip().startswith("#"):
        continue
    key, separator, value = raw_line.partition("=")
    if not separator or key_pattern.fullmatch(key) is None:
        raise SystemExit("fatal: production environment contains a malformed line")
    if key in values:
        raise SystemExit("fatal: production environment contains a duplicate key")
    values[key] = value

revision_mode = desired_revision or values.get("VIP_LIFECYCLE_REQUIRE_REVISION", "false")
if revision_mode not in {"true", "false"}:
    raise SystemExit("fatal: production VIP lifecycle revision mode is invalid")

lifecycle_secret = hmac.new(
    secret.encode("utf-8"),
    b"bss-vip-lifecycle-v1",
    hashlib.sha256,
).hexdigest()
managed = {
    "BSS_SITE_URL": "https://bss.games",
    "BSS_SSO_CLIENT_ID": "squad-admin-panel",
    "BSS_SSO_CLIENT_SECRET": secret,
    "BSS_SSO_CLIENT_SECRET_NEXT": "",
    "VIP_LIFECYCLE_WEBHOOK_SECRET": lifecycle_secret,
    "VIP_LIFECYCLE_REQUIRE_REVISION": revision_mode,
}
if desired_release_sha:
    managed["APP_VERSION"] = desired_release_sha
if verify_only:
    unchanged = {
        key: value
        for key, value in managed.items()
        if key != "VIP_LIFECYCLE_REQUIRE_REVISION"
    }
    if any(
        not hmac.compare_digest(
            values.get(key, "").encode("utf-8"), expected.encode("utf-8")
        )
        for key, expected in unchanged.items()
    ):
        raise SystemExit("fatal: production BSS SSO/VIP settings do not match")
    raise SystemExit(0)

rendered: list[str] = []
seen: set[str] = set()
for raw_line in source.splitlines(keepends=True):
    content = raw_line.removesuffix("\n").removesuffix("\r")
    if not content.strip() or content.lstrip().startswith("#"):
        rendered.append(raw_line)
        continue
    key, separator, _value = content.partition("=")
    seen.add(key)
    if key not in managed:
        rendered.append(raw_line)
        continue
    newline = "\r\n" if raw_line.endswith("\r\n") else "\n"
    rendered.append(f"{key}={managed[key]}{newline}")

if rendered and not rendered[-1].endswith(("\n", "\r")):
    rendered[-1] += "\n"
for key, value in managed.items():
    if key not in seen:
        rendered.append(f"{key}={value}\n")

directory_fd = os.open(path.parent, os.O_RDONLY)
temporary_name = ""
try:
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        delete=False,
    ) as temporary:
        temporary_name = temporary.name
        os.fchmod(temporary.fileno(), stat.S_IMODE(metadata.st_mode))
        temporary.write("".join(rendered))
        temporary.flush()
        os.fsync(temporary.fileno())
    os.replace(temporary_name, path)
    temporary_name = ""
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)
    if temporary_name:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
PY

unset shared_secret
if [[ "${BSS_SSO_ENV_VERIFY_ONLY:-}" == "true" ]]; then
  echo "BSS SSO and VIP lifecycle production settings verified"
else
  echo "BSS SSO and VIP lifecycle production settings configured"
fi
