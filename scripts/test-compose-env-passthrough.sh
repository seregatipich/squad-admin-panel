#!/usr/bin/env bash
# test-compose-env-passthrough.sh — regression guard for issue #46:
# .env.example documents DISCORD_CLIENT_ID/DISCORD_CLIENT_SECRET/
# DISCORD_PUBLIC_KEY/GLITCHTIP_DSN (consumed by apps/api/src/config.ts) and
# ADMINS_CFG_RELAY_INTERVAL_MS/ADMINS_CFG_RELAY_XADD_TIMEOUT_MS/
# LEADERBOARD_AGGREGATOR_INTERVAL_MS/LEADERBOARD_BACKFILL_MONTHS (consumed by
# apps/workers/config-sync and apps/workers/leaderboard-aggregator), but both
# compose files once left them out of the consuming service's `environment:`
# block, so filling them in .env exactly as documented had no effect. Run
# locally or in CI: `bash scripts/test-compose-env-passthrough.sh`.

set -u

SRC=$(cd "$(dirname "$0")/.." && pwd)

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

# var:compose-file-glob-independent check — for every (compose file, service
# region, variable) triple, the service's environment block must reference it.
check_var_in_service() {
  local file=$1 service=$2 var=$3
  # Extract the service's block: from its "  <service>:" line up to (but not
  # including) the next top-level (2-space-indented) key.
  awk -v svc="  $service:" '
    $0 == svc { found = 1; print; next }
    found && /^  [A-Za-z]/ { exit }
    found { print }
  ' "$SRC/$file" | grep -Fq "$var"
}

for file in docker/compose.yml docker/compose.stand.yml; do
  for pair in \
    "api:DISCORD_CLIENT_ID" \
    "api:DISCORD_CLIENT_SECRET" \
    "api:DISCORD_PUBLIC_KEY" \
    "api:GLITCHTIP_DSN" \
    "worker-config-sync:ADMINS_CFG_RELAY_INTERVAL_MS" \
    "worker-config-sync:ADMINS_CFG_RELAY_XADD_TIMEOUT_MS" \
    "worker-leaderboard-aggregator:LEADERBOARD_AGGREGATOR_INTERVAL_MS" \
    "worker-leaderboard-aggregator:LEADERBOARD_BACKFILL_MONTHS"
  do
    service=${pair%%:*}
    var=${pair#*:}
    got=absent
    check_var_in_service "$file" "$service" "$var" && got=present
    assert present "$file: $service passes through $var" "$got"
  done
done

echo
echo "compose-env-passthrough tests: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
