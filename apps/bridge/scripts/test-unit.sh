#!/bin/sh
# test:unit for @squad/bridge: the Go unit tests (internal/...), run where they can run.
#
# `pnpm test:unit` / `turbo run test:unit` reach every workspace, including the
# Go bridge, on machines that may have no Go toolchain, or only a non-Linux one
# (the bridge uses Linux-only syscalls, so it does not compile elsewhere). Such a
# machine skips the suite with a message and exits 0. Under CI the skip is an
# error, like a gated Postgres/Redis suite (#120): a runner without a usable Go
# toolchain must not go green by not running these tests.
set -u

skip() {
  if [ -n "${CI:-}" ]; then
    echo "[bridge] test:unit cannot run ($1) and CI is set: refusing to skip it silently" >&2
    exit 1
  fi
  echo "[bridge] skipping test:unit: $1"
  exit 0
}

command -v go >/dev/null 2>&1 || skip "go is not on PATH; install Go or rely on the go CI job"
[ "$(go env GOOS 2>/dev/null)" = linux ] || skip "Linux-only syscalls, run on a Linux host or in CI"

exec go test -race -count=1 ./internal/...
