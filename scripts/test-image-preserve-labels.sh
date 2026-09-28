#!/usr/bin/env bash
# test-image-preserve-labels.sh — regression guard for issue #46: every image
# the bridge runs with `docker run --pull never` (apps/bridge/internal/runner/
# docker.go) is built locally and never re-pulled, so DockerRunner.SystemPrune
# must never remove it. SystemPrune's `--filter label!=panel.preserve=true`
# spares only images whose Dockerfile bakes in `LABEL panel.preserve=true`.
# rnsquadjs.Dockerfile once lacked that label: a routine prune could delete
# its unused image and break new sidecar starts until the image was rebuilt.
# Run locally or in CI: `bash scripts/test-image-preserve-labels.sh`.

set -u

SRC=$(cd "$(dirname "$0")/.." && pwd)
DOCKER_GO="$SRC/apps/bridge/internal/runner/docker.go"

PASS=0
FAIL=0

assert() {
  local expected=$1 desc=$2 got=$3
  if [ "$got" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $desc"
    echo "      expected=$expected got=$got"
  fi
}

# --- SystemPrune still spares only panel.preserve=true images -----------------
got=absent
grep -Fq -- '--filter", "label!=panel.preserve=true"' "$DOCKER_GO" && got=present
assert present "SystemPrune still filters on label!=panel.preserve=true" "$got"

# --- every Dockerfile for a `--pull never` image carries the label ------------
# Keep this list in sync with the images DockerRunner launches with
# `--pull never`: squad-server (squad-server.Dockerfile), depot-init
# (depot-init.Dockerfile) and the rnsquadjs sidecar (docker/rnsquadjs.Dockerfile).
for dockerfile in \
  docker/squad-server.Dockerfile \
  docker/depot-init.Dockerfile \
  docker/rnsquadjs.Dockerfile
do
  got=absent
  grep -Eq 'LABEL[[:space:]].*panel\.preserve=true' "$SRC/$dockerfile" && got=present
  assert present "$dockerfile carries LABEL panel.preserve=true" "$got"
done

echo
echo "image-preserve-labels tests: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
