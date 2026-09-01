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
IFS= read -r shared_secret || [[ -n "$shared_secret" ]]
if (( ${#shared_secret} < 32 || ${#shared_secret} > 512 )) || [[ "$shared_secret" =~ [[:space:]] ]]; then
  echo "fatal: BSS SSO shared secret is invalid" >&2
  exit 1
fi

python3 - "$ENV_FILE" 3<<<"$shared_secret" <<'PY'
from __future__ import annotations

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

managed = {
    "BSS_SITE_URL": "https://bss.games",
    "BSS_SSO_CLIENT_ID": "squad-admin-panel",
    "BSS_SSO_CLIENT_SECRET": secret,
    "BSS_SSO_CLIENT_SECRET_NEXT": "",
}
key_pattern = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
source = path.read_text(encoding="utf-8")
rendered: list[str] = []
seen: set[str] = set()
for raw_line in source.splitlines(keepends=True):
    content = raw_line.removesuffix("\n").removesuffix("\r")
    if not content.strip() or content.lstrip().startswith("#"):
        rendered.append(raw_line)
        continue
    key, separator, _value = content.partition("=")
    if not separator or key_pattern.fullmatch(key) is None:
        raise SystemExit("fatal: production environment contains a malformed line")
    if key in seen:
        raise SystemExit("fatal: production environment contains a duplicate key")
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
echo "BSS SSO production settings configured"
