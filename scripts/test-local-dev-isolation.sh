#!/usr/bin/env bash
# test-local-dev-isolation.sh — contract tests for running several checkouts
# (worktrees) side by side on one machine:
#
#   1. docker/compose.yml keeps its defaults (project name squad-admin-panel,
#      host ports 80/443/5432/6379 — the stand and every existing install depend
#      on them) and lets COMPOSE_PROJECT_NAME, CADDY_HTTP_PORT, CADDY_HTTPS_PORT,
#      POSTGRES_HOST_PORT and REDIS_HOST_PORT move them, including the loopback
#      URLs of the host-network worker-rcon and the sidecar Redis URL;
#   2. scripts/prune-test-dbs.sh lists and drops only the leftover test
#      databases it should, and never without --yes.
#
# Part 1 renders the compose file with `docker compose config`, which needs no
# daemon; it is skipped (and says so) when the compose plugin is missing.
# Run locally or in CI: `bash scripts/test-local-dev-isolation.sh`.

set -u

SRC=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

assert() {
  local expected=$1 desc=$2 got=$3
  if [ "$got" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $desc"
    echo "      expected=$expected"
    echo "      got=$got"
  fi
}

# ---------------------------------------------------------------- compose --

compose_env="$WORK/compose.env"
cat >"$compose_env" <<'EOF'
POSTGRES_PASSWORD=pgpw
REDIS_PASSWORD=rpw
REDIS_SIDECAR_PASSWORD=spw
APP_ENCRYPTION_KEY=key
SESSION_SECRET=secret
RESTIC_PASSWORD=restic
DATA_DIR=./data
EOF

# Renders docker/compose.yml with only the variables given as arguments set, so
# whatever the caller exported cannot leak into the result.
render_compose() {
  (cd "$SRC" && env -i PATH="$PATH" HOME="${HOME:-/tmp}" "$@" \
    docker compose --env-file "$compose_env" -f docker/compose.yml config 2>/dev/null)
}

published_ports() {
  grep -E '^ +published: ' | sed -E 's/.*"([0-9]+)".*/\1/' | sort -n | tr '\n' ' '
}

if docker compose version >/dev/null 2>&1; then
  default_render=$(render_compose)
  assert "name: squad-admin-panel" "default project name" "$(printf '%s\n' "$default_render" | head -1)"
  assert "80 443 5432 6379 " "default published host ports" "$(printf '%s\n' "$default_render" | published_ports)"
  assert "present" "default worker-rcon Postgres URL" \
    "$(printf '%s\n' "$default_render" | grep -Fq 'DATABASE_URL: postgres://admin:pgpw@127.0.0.1:5432/admin' && echo present || echo absent)"
  assert "present" "default worker-rcon Redis URL" \
    "$(printf '%s\n' "$default_render" | grep -Fq 'REDIS_URL: redis://:rpw@127.0.0.1:6379' && echo present || echo absent)"
  assert "present" "default sidecar Redis URL" \
    "$(printf '%s\n' "$default_render" | grep -Fq 'SIDECAR_REDIS_URL: redis://rnsquadjs:spw@127.0.0.1:6379' && echo present || echo absent)"
  assert "present" "default named volume" \
    "$(printf '%s\n' "$default_render" | grep -Fq 'name: squad-admin-panel_postgres_data' && echo present || echo absent)"

  override_render=$(render_compose COMPOSE_PROJECT_NAME=wt-two CADDY_HTTP_PORT=8080 CADDY_HTTPS_PORT=8443 POSTGRES_HOST_PORT=15432 REDIS_HOST_PORT=16379)
  assert "name: wt-two" "overridden project name" "$(printf '%s\n' "$override_render" | head -1)"
  assert "8080 8443 15432 16379 " "overridden published host ports" "$(printf '%s\n' "$override_render" | published_ports)"
  assert "present" "overridden worker-rcon Postgres URL" \
    "$(printf '%s\n' "$override_render" | grep -Fq 'DATABASE_URL: postgres://admin:pgpw@127.0.0.1:15432/admin' && echo present || echo absent)"
  assert "present" "overridden worker-rcon Redis URL" \
    "$(printf '%s\n' "$override_render" | grep -Fq 'REDIS_URL: redis://:rpw@127.0.0.1:16379' && echo present || echo absent)"
  assert "present" "overridden sidecar Redis URL" \
    "$(printf '%s\n' "$override_render" | grep -Fq 'SIDECAR_REDIS_URL: redis://rnsquadjs:spw@127.0.0.1:16379' && echo present || echo absent)"
  assert "present" "overridden named volume" \
    "$(printf '%s\n' "$override_render" | grep -Fq 'name: wt-two_postgres_data' && echo present || echo absent)"
else
  echo "SKIP: docker compose is not installed — compose rendering checks not run"
fi

# Compose 2.15 turns `name: ${COMPOSE_PROJECT_NAME:-x}` into `compose_project_name-x`,
# which renames every volume of an existing install. COMPOSE_PROJECT_NAME already
# outranks `name:`, so the literal must stay.
assert "name: squad-admin-panel" "docker/compose.yml keeps a literal project name" \
  "$(grep -E '^name:' "$SRC/docker/compose.yml")"
assert "0" "docker/compose.stand.yml does not read the checkout-isolation variables" \
  "$(grep -cE 'CADDY_HTTP_PORT|CADDY_HTTPS_PORT|POSTGRES_HOST_PORT|REDIS_HOST_PORT' "$SRC/docker/compose.stand.yml")"

# ------------------------------------------------------------------ prune --

fixture="$WORK/fixture"
mkdir -p "$fixture/Main.Checkout/scripts" "$fixture/shims"
cp "$SRC/scripts/prune-test-dbs.sh" "$SRC/scripts/new-test-db.sh" "$fixture/Main.Checkout/scripts/"
repo="$fixture/Main.Checkout"
# Git hooks export GIT_DIR and friends; a fixture repository must not inherit
# them (it would operate on the repository that runs this test), nor run its
# hooks.
fixture_git() {
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR \
    git -c core.hooksPath=/dev/null -c user.name=t -c user.email=t@example.com "$@"
}
fixture_git -C "$repo" init -q -b work
fixture_git -C "$repo" commit -q --allow-empty -m init
fixture_git -C "$repo" worktree add -q "$fixture/Wt-Live" -b live
fixture_git -C "$repo" worktree add -q "$fixture/wt-gone" -b gone
rm -rf "$fixture/wt-gone"

log="$fixture/docker.log"
rows="$fixture/rows"
# `ps` names the one postgres container; the listing query answers from $rows
# (datname|age_days|connections); every other statement is logged.
cat >"$fixture/shims/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  ps) echo shim-postgres-1 ;;
  exec)
    case "$*" in
      *pg_database*) cat "$FIXTURE_ROWS" ;;
      *) printf '%s\n' "$*" >>"$FIXTURE_LOG" ;;
    esac
    ;;
esac
EOF
chmod +x "$fixture/shims/docker"

long_prepush="test_prepush_$(printf 'x%.0s' $(seq 1 50))"

run_prune() {
  : >"$log"
  (cd "$repo" && env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR \
    PATH="$fixture/shims:$PATH" FIXTURE_ROWS="$rows" FIXTURE_LOG="$log" PG_CONTAINER="" COMPOSE_PROJECT_NAME="" \
    bash scripts/prune-test-dbs.sh "$@" 2>&1)
}

cat >"$rows" <<EOF
test_prepush_main_checkout|40|0
test_prepush_wt_live|2|0
test_prepush_wt_gone|1|0
test_prepush_wt_busy|1|2
test_agent_slug|20|0
test_fresh_slug|2|0
test_unknown_age|-1|0
${long_prepush}|1|0
EOF

out=$(run_prune)
assert "present" "dry run lists a database whose worktree is gone" \
  "$(printf '%s\n' "$out" | grep -Fq 'would drop  test_prepush_wt_gone (its worktree no longer exists)' && echo present || echo absent)"
assert "absent" "the main checkout's database is kept" \
  "$(printf '%s\n' "$out" | grep -Fq 'test_prepush_main_checkout' && echo present || echo absent)"
assert "absent" "a live worktree's database is kept (directory name is lower-cased)" \
  "$(printf '%s\n' "$out" | grep -Fq 'test_prepush_wt_live' && echo present || echo absent)"
assert "absent" "no age flag leaves a non-worktree database alone" \
  "$(printf '%s\n' "$out" | grep -Fq 'test_agent_slug' && echo present || echo absent)"
assert "absent" "a name at the identifier limit is not matched against worktrees" \
  "$(printf '%s\n' "$out" | grep -Fq "$long_prepush" && echo present || echo absent)"
assert "present" "an open connection is reported and the database kept" \
  "$(printf '%s\n' "$out" | grep -Fq 'keep  test_prepush_wt_busy (its worktree no longer exists, but 2 connection(s) are open)' && echo present || echo absent)"
assert "present" "dry run says nothing was dropped" \
  "$(printf '%s\n' "$out" | grep -Fq 'nothing was dropped — re-run with --yes' && echo present || echo absent)"
assert "0" "dry run issues no DROP" "$(grep -c 'DROP DATABASE' "$log")"

out=$(run_prune --older-than 14)
assert "present" "--older-than lists an old database whatever created it" \
  "$(printf '%s\n' "$out" | grep -Fq 'would drop  test_agent_slug (created 20 days ago)' && echo present || echo absent)"
assert "present" "--older-than also lists a database whose worktree is gone" \
  "$(printf '%s\n' "$out" | grep -Fq 'would drop  test_prepush_wt_gone' && echo present || echo absent)"
assert "absent" "--older-than keeps a young database" \
  "$(printf '%s\n' "$out" | grep -Fq 'test_fresh_slug' && echo present || echo absent)"
assert "absent" "--older-than ignores a database with an unreadable age" \
  "$(printf '%s\n' "$out" | grep -Fq 'test_unknown_age' && echo present || echo absent)"
assert "absent" "--older-than does not list a live worktree's young database" \
  "$(printf '%s\n' "$out" | grep -Fq 'test_prepush_wt_live' && echo present || echo absent)"
assert "present" "--older-than lists a live worktree's old database" \
  "$(printf '%s\n' "$out" | grep -Fq 'would drop  test_prepush_main_checkout (created 40 days ago)' && echo present || echo absent)"

out=$(run_prune --yes)
assert "1" "--yes drops exactly the orphan" "$(grep -c 'DROP DATABASE' "$log")"
assert "present" "--yes drops the database whose worktree is gone, without FORCE-less statements" \
  "$(grep -Fq 'DROP DATABASE IF EXISTS "test_prepush_wt_gone" WITH (FORCE)' "$log" && echo present || echo absent)"
assert "present" "--yes reports what it dropped" \
  "$(printf '%s\n' "$out" | grep -Fq 'dropped 1 of 2 candidate database(s)' && echo present || echo absent)"

out=$(run_prune --yes --older-than 14)
assert "3" "--yes --older-than drops the orphan, the old agent database and the old checkout database" \
  "$(grep -c 'DROP DATABASE' "$log")"

printf 'test_agent_slug; DROP DATABASE admin|99|0\n' >"$rows"
out=$(run_prune --yes --older-than 1)
assert "0" "a name that is not a plain identifier is never interpolated into SQL" "$(grep -c 'DROP DATABASE' "$log")"

out=$(run_prune --bogus)
assert "present" "an unknown option is rejected with usage" \
  "$(printf '%s\n' "$out" | grep -Fq 'usage: prune-test-dbs.sh' && echo present || echo absent)"
out=$(run_prune --older-than soon)
assert "present" "a non-numeric --older-than is rejected" \
  "$(printf '%s\n' "$out" | grep -Fq 'whole number of days' && echo present || echo absent)"

echo
echo "local-dev-isolation tests: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
