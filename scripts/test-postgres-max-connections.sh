#!/usr/bin/env bash
# test-postgres-max-connections.sh — regression guard for finding #1097: the
# per-process postgres.js pools (API and five workers at 16 each, the rest
# smaller) sum to ~134 connections, more than Postgres's default
# max_connections=100, so a load spike starved the migrator and operator psql
# of a connection. Every compose file that runs the postgres service must
# raise max_connections above that budget.
# Run locally or in CI: `bash scripts/test-postgres-max-connections.sh`.

set -u

SRC=$(cd "$(dirname "$0")/.." && pwd)
MIN_MAX_CONNECTIONS=200

PASS=0
FAIL=0

for compose in docker/compose.yml docker/compose.stand.yml; do
  value=$(awk '
    /^  postgres:/ { in_pg = 1; next }
    in_pg && /^  [a-z]/ { in_pg = 0 }
    in_pg && /max_connections=/ {
      sub(/.*max_connections=/, ""); sub(/[^0-9].*/, ""); print; exit
    }
  ' "$SRC/$compose")
  if [ -n "$value" ] && [ "$value" -ge "$MIN_MAX_CONNECTIONS" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $compose postgres service must set max_connections >= $MIN_MAX_CONNECTIONS (got '${value:-unset}')"
  fi
done

echo
echo "postgres-max-connections tests: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
