#!/usr/bin/env bash
# test-ci-runner-strategy.sh — lock the CI/CD job graph: every job on an
# ephemeral GitHub-hosted VM, verification only for `master`, and the tk104
# development stand fed straight from `dev`.
#
# History: verification first ran hosted beside a self-hosted production deploy
# runner (#286), then on an organization runner group; the repository now lives
# on a personal account (no runner groups at all) and is public (hosted minutes
# are free). tk104 is a development stand: a `dev` push builds the images on
# hosted VMs, pushes them to GHCR, and hands tk104 the commit and digests over a
# forced-command SSH key, so no job runs on the host and no runner lives there.
# CI runs only on `master` and on dispatch.
#
# The test fails if a job leaves the hosted image, if anything selects a
# self-hosted runner or a runner group, if a trigger or a gate drifts, or if the
# test-slice wiring (shards, blob reports, merged coverage) comes apart.
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
ci_workflow="$repo_root/.github/workflows/ci.yml"
deploy_workflow="$repo_root/.github/workflows/deploy-tk104.yml"

fail() {
  echo "test-ci-runner-strategy: FAIL — $1" >&2
  exit 1
}

job_block() {
  local workflow=$1
  local job=$2
  awk -v job="$job" '
    $0 == "  " job ":" { inside = 1 }
    inside && /^  [a-zA-Z0-9_-]+:$/ && $0 != "  " job ":" { exit }
    inside { print }
  ' "$workflow"
}

job_names() {
  sed -n '/^jobs:$/,$p' "$1" | sed -n 's/^  \([a-zA-Z0-9_-]*\):$/\1/p'
}

# Prints the dedented `run: |` body of the step named $2 in the job block $1.
step_run() {
  awk -v name="$2" '
    $0 == "      - name: " name { in_step = 1; next }
    in_step && /^      - / { exit }
    in_step && $0 == "        run: |" { in_run = 1; next }
    in_run && length($0) > 0 && substr($0, 1, 10) != "          " { exit }
    in_run { sub(/^          /, ""); print }
  ' <<<"$1"
}

has_line() {
  printf '%s\n' "$1" | grep -Fxq -- "$2"
}

has_text() {
  printf '%s\n' "$1" | grep -Fq -- "$2"
}

[ -f "$ci_workflow" ] || fail 'ci workflow is missing'
[ -f "$deploy_workflow" ] || fail 'deploy workflow is missing'
command -v jq >/dev/null 2>&1 || fail 'jq is required'

HOSTED_IMAGE='ubuntu-24.04'

# --- Runners: hosted everywhere, never self-hosted, never a runner group. ---
for workflow in "$ci_workflow" "$deploy_workflow"; do
  name=$(basename "$workflow")
  if grep -Eq '^[[:space:]]*runs-on:.*self-hosted|^[[:space:]]*-[[:space:]]*self-hosted' "$workflow"; then
    fail "$name still references a self-hosted runner"
  fi
  # A personal-account repository has no runner groups: a job that selects one
  # waits in the queue forever without an error.
  if grep -Eq '^[[:space:]]*runs-on:[[:space:]]*$' "$workflow"; then
    fail "$name selects a runner group instead of a hosted image"
  fi
  if sed -n '/^on:/,/^[a-z]/p' "$workflow" | grep -Eq '^[[:space:]]+pull_request(_target)?:'; then
    fail "$name is triggered by pull requests"
  fi
  jobs=$(job_names "$workflow")
  [ -n "$jobs" ] || fail "$name declares no jobs"
  while IFS= read -r job; do
    has_line "$(job_block "$workflow" "$job")" "    runs-on: ${HOSTED_IMAGE}" ||
      fail "$name job '$job' does not use the pinned GitHub-hosted image ${HOSTED_IMAGE}"
  done <<<"$jobs"
done

# --- ci.yml: master pushes and dispatches only. ---
ci_on=$(sed -n '/^on:$/,/^[a-z]/p' "$ci_workflow")
has_line "$ci_on" '    branches: [master]' || fail 'ci push trigger is not restricted to master'
has_line "$ci_on" '  workflow_dispatch:' || fail 'ci cannot be dispatched by hand'
if grep -Eq 'branches: \[[^]]*dev' "$ci_workflow"; then
  fail 'ci runs on dev again; dev deploys to tk104 without tests'
fi
if grep -Fq "github.ref != 'refs/heads/master'" "$ci_workflow"; then
  fail 'a ci job still skips on master, where ci now runs'
fi
grep -Fq 'cancel-in-progress: true' "$ci_workflow" ||
  fail 'superseded ci runs are not cancelled'
for gone in 'Require a green dev CI run' 'check-runner-health' 'lcov.info' 'docker save' 'release-images'; do
  if grep -Fq "$gone" "$ci_workflow"; then
    fail "ci still contains '$gone'"
  fi
done

ci_jobs=$(job_names "$ci_workflow")
expected_jobs='branch-guard lint test-api test-web test-packages scripts changes mutation go images backup gate'
[ "$(printf '%s\n' "$ci_jobs" | tr '\n' ' ' | sed 's/ $//')" = "$expected_jobs" ] ||
  fail "ci jobs are '$(printf '%s\n' "$ci_jobs" | tr '\n' ' ')', expected '$expected_jobs'"

branch_guard=$(job_block "$ci_workflow" branch-guard)
if printf '%s\n' "$branch_guard" | grep -Eq '^    if:'; then
  fail 'branch-guard must run on every ci run'
fi
has_text "$branch_guard" "if: github.event_name == 'push' && github.ref == 'refs/heads/master'" ||
  fail 'branch-guard no longer audits master pushes'
has_text "$branch_guard" 'git merge-base --is-ancestor "$GITHUB_SHA" origin/dev' ||
  fail 'branch-guard no longer proves the master tip came from dev'
for suite in test-git-guard test-verify-done test-pre-push-checklist test-workflow-pins \
  test-gitignore-patterns test-workflow-security test-codeql-default-setup \
  test-ci-runner-strategy test-ci-test-shard; do
  has_text "$branch_guard" "run: bash scripts/${suite}.sh" ||
    fail "branch-guard does not run scripts/${suite}.sh"
done

lint=$(job_block "$ci_workflow" lint)
for command in 'pnpm exec biome check .' 'bash scripts/test-cov-complete.sh' \
  'pnpm run solve:issues:test' 'pnpm turbo run typecheck --concurrency=4' \
  './gitleaks detect --config .gitleaks.toml'; do
  has_text "$lint" "$command" || fail "lint does not run '$command'"
done
printf '%s\n' "$lint" | grep -Eq 'uses:[[:space:]]+actions/cache@[0-9a-f]{40}' ||
  fail 'lint does not restore the Turbo cache through a SHA-pinned actions/cache'
has_line "$lint" '          path: .turbo/cache' || fail 'lint caches something other than .turbo/cache'
has_line "$lint" '          key: turbo-lint-${{ github.sha }}' || fail 'lint Turbo cache key is not per job and commit'
has_line "$lint" '          restore-keys: turbo-lint-' || fail 'lint Turbo cache does not fall back to the last run'

# The Turbo caches only hit when a task hash is stable between runs. The
# service containers get a new host port every run, so connection settings
# reach the tasks as pass-through variables and never enter the hash.
turbo_json="$repo_root/turbo.json"
for variable in DATABASE_URL TEST_DATABASE_URL REDIS_URL TEST_REDIS_URL POSTGRES_PASSWORD \
  APP_ENCRYPTION_KEY PANEL_BRIDGE_SOCKET; do
  jq -e --arg name "$variable" '(.globalEnv // []) | index($name) == null' "$turbo_json" >/dev/null ||
    fail "turbo.json hashes ${variable}, so every CI run misses the Turbo cache"
  jq -e --arg name "$variable" '(.globalPassThroughEnv // []) | index($name) != null' "$turbo_json" >/dev/null ||
    fail "turbo.json does not pass ${variable} through to the tasks"
done

# Dependabot opens its pull requests against dev: master only fast-forwards.
dependabot="$repo_root/.github/dependabot.yml"
ecosystems=$(grep -Ec '^  - package-ecosystem:' "$dependabot")
dev_targets=$(grep -Ec '^    target-branch: "?dev"?$' "$dependabot")
[ "$ecosystems" -gt 0 ] && [ "$dev_targets" -eq "$ecosystems" ] ||
  fail "dependabot targets dev for ${dev_targets} of ${ecosystems} ecosystem(s)"

# --- Test slices. ---
# Postgres/Redis data stays on bounded tmpfs mounts so an interrupted job never
# leaves anonymous volumes behind; health checks poll every 2 s.
for job in test-api test-packages scripts; do
  block=$(job_block "$ci_workflow" "$job")
  has_text "$block" '--tmpfs /var/lib/postgresql/data:rw,size=1g' ||
    fail "${job}: Postgres service may leak its image-declared anonymous volume"
  has_text "$block" '--tmpfs /data:rw,size=128m' ||
    fail "${job}: Redis service may leak its image-declared anonymous volume"
  [ "$(printf '%s\n' "$block" | grep -Fc -- '--health-interval 2s')" -eq 2 ] ||
    fail "${job}: a service health check does not poll every 2 s"
  if printf '%s\n' "$block" | grep -Eq 'docker (system|volume|builder) prune'; then
    fail "${job} contains a broad Docker cleanup"
  fi
done

# A slice's shard count must match its matrix, or a shard is never run.
check_sharded_slice() {
  local job=$1 package=$2 dir=$3 count=$4
  local block
  block=$(job_block "$ci_workflow" "$job")
  local shards
  shards=$(seq 1 "$count" | paste -sd, - | sed 's/,/, /g')
  has_line "$block" "        shard: [${shards}]" ||
    fail "${job} matrix is not shards [${shards}]"
  has_text "$block" "run: bash scripts/ci-test-shard.sh ${package} \${{ matrix.shard }} ${count}" ||
    fail "${job} does not run its shard of ${count} through ci-test-shard.sh"
  has_line "$block" "          name: vitest-blob-${package}-\${{ matrix.shard }}" ||
    fail "${job} does not upload its blob report under the name the gate downloads"
  has_line "$block" "          path: ${dir}/.vitest-reports/blob-\${{ matrix.shard }}-${count}.json" ||
    fail "${job} does not upload the exact blob file ci-test-shard.sh writes"
  has_line "$block" '          include-hidden-files: true' ||
    fail "${job} would drop the blob report: .vitest-reports is a hidden directory"
  has_line "$block" '          if-no-files-found: error' ||
    fail "${job} tolerates a missing blob report"
  if printf '%s\n' "$block" | grep -Eq 'run: pnpm turbo run build|run: pnpm --filter @squad/db migrate'; then
    fail "${job} builds or migrates; its suite resolves @squad/* to source and builds its own template database"
  fi
}
check_sharded_slice test-api api apps/api 4
check_sharded_slice test-web web apps/web 2

test_api=$(job_block "$ci_workflow" test-api)
has_line "$test_api" '      VITEST_MAX_FORKS: "4"' || fail 'test-api does not use all four hosted vCPUs'
tune=$(step_run "$test_api" 'Tune Postgres for throwaway test data')
has_text "$tune" 'docker exec "${PG_CONTAINER}" psql' || fail 'test-api does not tune its Postgres service'
for setting in 'fsync = off' 'synchronous_commit = off' 'full_page_writes = off'; do
  has_text "$tune" "-c 'ALTER SYSTEM SET ${setting}'" ||
    fail "test-api does not set '${setting}' as its own statement"
done
has_text "$tune" "-c 'SELECT pg_reload_conf()'" || fail 'test-api does not reload the tuned settings'
has_text "$test_api" 'PG_CONTAINER: ${{ job.services.postgres.id }}' ||
  fail 'test-api does not address the Postgres service container'

test_web=$(job_block "$ci_workflow" test-web)
if has_text "$test_web" 'services:'; then
  fail 'test-web starts services its jsdom suite never uses'
fi

test_packages=$(job_block "$ci_workflow" test-packages)
has_text "$test_packages" "run: pnpm turbo run build --concurrency=4 --filter='./apps/workers/*'" ||
  fail 'test-packages does not build exactly what the worker contract tests start'
has_text "$test_packages" 'run: bash scripts/ci-test-shard.sh packages' ||
  fail 'test-packages does not run the packages slice'
has_line "$test_packages" '      PNPM_WORKSPACE_CONCURRENCY: "4"' ||
  fail 'test-packages does not run four packages at a time'
has_line "$test_packages" '          key: turbo-test-packages-${{ github.sha }}' ||
  fail 'test-packages does not cache its Turbo build per job and commit'
if has_text "$test_packages" 'upload-artifact'; then
  fail 'test-packages still uploads coverage nobody reads'
fi

scripts_job=$(job_block "$ci_workflow" scripts)
if has_text "$scripts_job" 'turbo run build'; then
  fail 'scripts job runs the full build; pnpm test:scripts builds what it needs'
fi

changes=$(job_block "$ci_workflow" changes)
has_text "$changes" '-- packages/shared-config' || fail 'the Stryker gate does not diff packages/shared-config'
has_line "$changes" '          fetch-depth: 0' || fail 'the Stryker gate cannot resolve the pushed range'
mutation=$(job_block "$ci_workflow" mutation)
has_line "$mutation" '    needs: changes' || fail 'mutation does not wait for the change detection'
has_line "$mutation" "    if: needs.changes.outputs.mutation == 'true'" ||
  fail 'Stryker is not gated on a shared-config change'
has_text "$mutation" 'pnpm turbo run test:mutation --filter=@squad/shared-config' ||
  fail 'mutation job does not run Stryker on shared-config'

go_block=$(job_block "$ci_workflow" go)
printf '%s\n' "$go_block" | grep -Eq 'uses:[[:space:]]+actions/setup-go@[0-9a-f]{40}' ||
  fail 'go job does not install Go through a SHA-pinned setup action'
has_text "$go_block" 'cache-dependency-path: apps/bridge/go.sum' ||
  fail 'go cache is not keyed by the bridge module dependency file'
has_line "$go_block" '      - run: go test -race -count=1 ./...' ||
  fail 'go job does not run the race detector directly on the hosted VM'
if printf '%s\n' "$go_block" | grep -Eq 'docker run|^[[:space:]]+container:'; then
  fail 'go job still carries the self-hosted container workaround'
fi
has_text "$go_block" 'go install golang.org/x/vuln/cmd/govulncheck@v1.7.0' ||
  fail 'govulncheck is not pinned to the accepted release'
if has_text "$go_block" 'govulncheck@latest'; then
  fail 'govulncheck still changes implicitly between CI runs'
fi
has_text "$go_block" 'if ldd bin/panel-host-bridge' ||
  fail 'go job no longer proves the bridge binary is statically linked'

# --- Images: built from docker-bake.hcl, read-only registry cache, smoke-tested. ---
images=$(job_block "$ci_workflow" images)
has_text "$images" 'id: buildx' || fail 'images job does not expose its builder name'
printf '%s\n' "$images" | grep -Eq 'uses:[[:space:]]+docker/bake-action@[0-9a-f]{40}' ||
  fail 'images job does not build docker-bake.hcl through the SHA-pinned bake action'
has_text "$images" 'TAG: ${{ github.sha }}' || fail 'images are not tagged with the commit they were built from'
has_text "$images" 'source: .' || fail 'bake builds a remote Git context instead of the checked-out tree'
has_line "$images" '          targets: release,rnsquadjs' || fail 'images job does not build the release group and rnsquadjs'
has_line "$images" '          load: true' || fail 'images are not loaded for the smoke tests'
has_line "$images" '      packages: read' || fail 'images job cannot read the GHCR layer cache'
if has_text "$images" 'packages: write' || has_text "$images" 'cache-to=type=registry'; then
  fail 'ci writes the GHCR cache; only the dev deploy build may'
fi
for target in api web workers caddy-tk104 rnsquadjs; do
  grep -Fq "target \"${target}\"" "$repo_root/docker-bake.hcl" ||
    fail "docker-bake.hcl has no '${target}' target"
done
for target in api web workers caddy-tk104; do
  has_text "$images" "${target}.cache-from=type=registry,ref=ghcr.io/seregatipich/squad-panel-${target}:buildcache" ||
    fail "bake target '${target}' does not reuse the GHCR layer cache the deploy build writes"
done
has_text "$images" 'rnsquadjs.cache-from=type=gha,scope=rnsquadjs' ||
  fail 'rnsquadjs lost its layer cache'
has_text "$images" "await import('postgres')" || fail 'the api image smoke test is gone'
has_text "$images" 'compose.tk104.yml' || fail 'the workers image is not checked against compose.tk104.yml'
has_text "$images" '[[ "${status}" -eq 64 ]]' || fail 'the workers image exit-64 smoke test is gone'
if has_text "$images" 'upload-artifact' || has_text "$images" 'test-backup-restore'; then
  fail 'images job exports images or runs the backup round trip'
fi
if printf '%s\n' "$images" | grep -Eq 'run:[[:space:]]+docker build[[:space:]]'; then
  fail 'images job builds outside buildx bake'
fi

backup=$(job_block "$ci_workflow" backup)
has_text "$backup" 'run: bash scripts/test-backup-restore.sh' || fail 'the backup/restore round trip is not run'
has_text "$backup" 'CI_BUILDX_BUILDER: ${{ steps.buildx.outputs.name }}' ||
  fail 'backup round-trip does not receive the builder name'

# --- The gate: the single required check. ---
gate=$(job_block "$ci_workflow" gate)
has_line "$gate" '    if: always()' || fail 'the gate is skipped instead of failing when a job fails'
gate_needs=$(printf '%s\n' "$gate" | sed -n 's/^    needs: \[\(.*\)\]$/\1/p' | tr -d ' ' | tr ',' '\n' | sort)
other_jobs=$(printf '%s\n' "$ci_jobs" | grep -vx gate | sort)
[ "$gate_needs" = "$other_jobs" ] ||
  fail "the gate does not wait for every other ci job: $(diff <(printf '%s\n' "$other_jobs") <(printf '%s\n' "$gate_needs") | tr '\n' ' ')"

gate_check=$(step_run "$gate" 'Require every check')
[ -n "$gate_check" ] || fail 'the gate has no "Require every check" step'
# The `needs` context for every job succeeding, except the `job=result` pairs in $1.
needs_json() {
  printf '%s\n' "$other_jobs" | jq -R -s --arg override "$1" '
    ($override | split(" ") | map(select(. != "") | split("=") | {(.[0]): .[1]}) | add // {}) as $results
    | split("\n") | map(select(. != "") | {(.): {result: ($results[.] // "success"), outputs: {}}}) | add'
}
gate_accepts() {
  NEEDS=$(needs_json "$1") bash -eo pipefail -c "$gate_check" >/dev/null 2>&1
}
gate_accepts '' || fail 'the gate rejects a run where every job succeeded'
gate_accepts 'mutation=skipped' || fail 'the gate rejects a run where only Stryker was skipped'
for verdict in 'mutation=failure' 'mutation=cancelled' 'test-api=skipped' 'test-api=failure' \
  'lint=cancelled' 'changes=skipped' 'images=failure' 'backup=skipped' 'branch-guard=failure'; do
  if gate_accepts "$verdict"; then
    fail "the gate accepts a run where ${verdict/=/ was }"
  fi
done

for package in api web; do
  has_line "$gate" "          pattern: vitest-blob-${package}-*" ||
    fail "the gate does not download every ${package} shard's blob report"
  has_line "$gate" "          path: apps/${package}/.vitest-reports" ||
    fail "the gate does not place the ${package} blobs where --merge-reports reads them"
  has_line "$gate" "        working-directory: apps/${package}" ||
    fail "the gate does not merge in apps/${package}, whose vitest.config.ts holds the thresholds"
done
[ "$(printf '%s\n' "$gate" | grep -Fxc '        run: pnpm exec vitest run --merge-reports --coverage')" -eq 2 ] ||
  fail 'the gate does not enforce merged coverage for both sharded suites'

# --- deploy-tk104.yml: dev pushes build on hosted VMs and deploy over SSH. ---
deploy_on=$(sed -n '/^on:$/,/^[a-z]/p' "$deploy_workflow")
has_line "$deploy_on" '    branches: [dev]' || fail 'deploy does not follow dev pushes'
has_line "$deploy_on" '  workflow_dispatch:' || fail 'deploy cannot be dispatched for a redeploy or rollback'
if grep -Eq 'refs/heads/master|workflow_run|environment: production' "$deploy_workflow"; then
  fail 'deploy still targets the former master production release'
fi
if sed -n '1,/^jobs:$/p' "$deploy_workflow" | grep -Eq '^concurrency:'; then
  fail 'deploy has workflow-level concurrency; builds and the deploy queue separately'
fi
[ "$(job_names "$deploy_workflow" | tr '\n' ' ')" = 'build deploy ' ] ||
  fail 'deploy workflow is not exactly the build and deploy jobs'
while IFS= read -r job; do
  has_text "$(job_block "$deploy_workflow" "$job")" "github.repository == 'seregatipich/squad-admin-panel'" ||
    fail "deploy job '$job' would also run in a fork"
done < <(job_names "$deploy_workflow")
deploy_job=$(job_block "$deploy_workflow" deploy)
has_line "$deploy_job" '      name: tk104-dev' || fail 'deploy can read the tk104 secrets outside the tk104-dev environment'
has_line "$deploy_job" '      url: https://tk104.duckdns.org' || fail 'deploy environment does not link the stand'
has_line "$deploy_job" '    needs: build' || fail 'deploy does not wait for the image builds'

backup_script="$repo_root/scripts/test-backup-restore.sh"
grep -Fq 'TOOL_IMG="squad-panel/restic:citest-${SFX}"' "$backup_script" ||
  fail 'backup round-trip toolbox image is not run-scoped'
grep -Fq 'docker image rm --force "$TOOL_IMG"' "$backup_script" ||
  fail 'backup round-trip does not remove its toolbox image on exit'
grep -Fq 'docker buildx build --builder "$CI_BUILDX_BUILDER" --load' "$backup_script" ||
  fail 'backup round-trip does not share the isolated CI builder'

for node_dockerfile in \
  "$repo_root/docker/api.Dockerfile" \
  "$repo_root/docker/worker.Dockerfile" \
  "$repo_root/docker/web.Dockerfile"
do
  corepack_block=$(sed -n '/^RUN corepack enable/,/^WORKDIR \/app$/p' "$node_dockerfile" | sed '$d')
  grep -Fq 'ARG PNPM_VERSION=9.15.0' "$node_dockerfile" ||
    fail "$(basename "$node_dockerfile") does not pin the pnpm version"
  printf '%s\n' "$corepack_block" | grep -Fq 'for attempt in 1 2 3; do' ||
    fail "$(basename "$node_dockerfile") does not retry the Corepack download"
  printf '%s\n' "$corepack_block" | grep -Fq 'corepack prepare "pnpm@${PNPM_VERSION}" --activate' ||
    fail "$(basename "$node_dockerfile") does not activate the exact pnpm release"
  printf '%s\n' "$corepack_block" | grep -Fq 'test "$(pnpm --version)" = "$PNPM_VERSION"' ||
    fail "$(basename "$node_dockerfile") does not verify the activated pnpm version"
  printf '%s\n' "$corepack_block" | grep -Fq 'test "$attempt" -eq 3 || sleep "$((attempt * 5))"' ||
    fail "$(basename "$node_dockerfile") does not use bounded 5/10 second backoff"
  printf '%s\n' "$corepack_block" | tail -n 1 | grep -Fxq '    exit 1' ||
    fail "$(basename "$node_dockerfile") masks the third Corepack failure"
done

corepack_fixture=$(mktemp -d)
cleanup_corepack_fixture() {
  find "$corepack_fixture" -xdev -depth -delete 2>/dev/null || true
}
trap cleanup_corepack_fixture EXIT
printf '%s\n' \
  '#!/bin/sh' \
  'if [ "$1" = enable ]; then exit 0; fi' \
  'attempt=$(cat "$COREPACK_ATTEMPTS_FILE")' \
  'attempt=$((attempt + 1))' \
  'printf "%s\n" "$attempt" > "$COREPACK_ATTEMPTS_FILE"' \
  '[ "$attempt" -eq "$COREPACK_SUCCEED_ON" ]' \
  > "$corepack_fixture/corepack"
printf '%s\n' \
  '#!/bin/sh' \
  'printf "%s\n" "9.15.0"' \
  > "$corepack_fixture/pnpm"
printf '%s\n' \
  '#!/bin/sh' \
  'printf "%s\n" "$1" >> "$COREPACK_DELAYS_FILE"' \
  > "$corepack_fixture/sleep"
chmod +x "$corepack_fixture/corepack" "$corepack_fixture/pnpm" "$corepack_fixture/sleep"
corepack_command=$(sed -n '/^RUN corepack enable/,/^WORKDIR \/app$/p' \
  "$repo_root/docker/api.Dockerfile" | sed '$d; 1s/^RUN //; s/[[:space:]]*\\$//')

assert_corepack_retry() {
  local succeed_on=$1
  local expected_status=$2
  local expected_attempts=$3
  local expected_delays=$4
  local status
  local actual_attempts
  local actual_delays
  printf '0\n' > "$corepack_fixture/attempts"
  : > "$corepack_fixture/delays"
  PATH="$corepack_fixture:$PATH" \
    PNPM_VERSION=9.15.0 \
    COREPACK_SUCCEED_ON="$succeed_on" \
    COREPACK_ATTEMPTS_FILE="$corepack_fixture/attempts" \
    COREPACK_DELAYS_FILE="$corepack_fixture/delays" \
    /bin/sh -c "$corepack_command"
  status=$?
  actual_attempts=$(cat "$corepack_fixture/attempts")
  actual_delays=$(tr '\n' ',' < "$corepack_fixture/delays")
  [ "$status" -eq "$expected_status" ] ||
    fail "Corepack retry case $succeed_on returned $status instead of $expected_status"
  [ "$actual_attempts" -eq "$expected_attempts" ] ||
    fail "Corepack retry case $succeed_on made $actual_attempts attempt(s) instead of $expected_attempts"
  [ "$actual_delays" = "$expected_delays" ] ||
    fail "Corepack retry case $succeed_on used delays '$actual_delays' instead of '$expected_delays'"
}

assert_corepack_retry 1 0 1 ''
assert_corepack_retry 2 0 2 '5,'
assert_corepack_retry 3 0 3 '5,10,'
assert_corepack_retry 4 1 3 '5,10,'
cleanup_corepack_fixture
trap - EXIT

rnsquadjs_dockerfile="$repo_root/docker/rnsquadjs.Dockerfile"
grep -Fq 'ARG YARN_VERSION=1.22.22' "$rnsquadjs_dockerfile" ||
  fail 'RNSquadJS build does not pin the Yarn Classic version'
grep -Fq 'corepack prepare "yarn@${YARN_VERSION}" --activate' "$rnsquadjs_dockerfile" ||
  fail 'RNSquadJS build still lets Corepack resolve yarn/latest'
grep -Fq 'test "$(yarn --version)" = "$YARN_VERSION"' "$rnsquadjs_dockerfile" ||
  fail 'RNSquadJS build does not verify the activated Yarn version'
if grep -Fq 'corepack enable && yarn install' "$rnsquadjs_dockerfile"; then
  fail 'RNSquadJS build invokes Yarn before activating an exact release'
fi

grep -Fq 'yarn add ioredis@5.10.1 uuid@14.0.0 --exact --network-timeout 600000' \
  "$rnsquadjs_dockerfile" ||
  fail 'RNSquadJS panelBridge dependencies are not pinned exactly'
grep -Fq 'for delay in 0 5 10; do' "$rnsquadjs_dockerfile" ||
  fail 'RNSquadJS panelBridge dependency download has no bounded retry'
grep -Fq '[ "$deps_installed" = true ]' "$rnsquadjs_dockerfile" ||
  fail 'RNSquadJS panelBridge dependency retry can mask the final failure'

rnsquad_deps_fixture=$(mktemp -d)
cleanup_rnsquad_deps_fixture() {
  find "$rnsquad_deps_fixture" -xdev -depth -delete 2>/dev/null || true
}
trap cleanup_rnsquad_deps_fixture EXIT
printf '%s\n' \
  '#!/bin/sh' \
  'attempt=$(cat "$RNSQUAD_DEPS_ATTEMPTS_FILE")' \
  'attempt=$((attempt + 1))' \
  'printf "%s\n" "$attempt" > "$RNSQUAD_DEPS_ATTEMPTS_FILE"' \
  'printf "%s\n" "$*" >> "$RNSQUAD_DEPS_ARGS_FILE"' \
  '[ "$attempt" -eq "$RNSQUAD_DEPS_SUCCEED_ON" ]' \
  > "$rnsquad_deps_fixture/yarn"
printf '%s\n' \
  '#!/bin/sh' \
  'printf "%s\n" "$1" >> "$RNSQUAD_DEPS_DELAYS_FILE"' \
  > "$rnsquad_deps_fixture/sleep"
chmod +x "$rnsquad_deps_fixture/yarn" "$rnsquad_deps_fixture/sleep"
rnsquad_deps_command=$(sed -n '/^RUN deps_installed=false/,/^# panelBridge sources/p' \
  "$rnsquadjs_dockerfile" | sed '$d; 1s/^RUN //; s/[[:space:]]*\\$//' | tr '\n' ' ')
[ -n "$rnsquad_deps_command" ] ||
  fail 'RNSquadJS panelBridge dependency retry command cannot be extracted'

assert_rnsquad_deps_retry() {
  local succeed_on=$1
  local expected_status=$2
  local expected_attempts=$3
  local expected_delays=$4
  local status
  local actual_attempts
  local actual_delays
  local unexpected_args
  printf '0\n' > "$rnsquad_deps_fixture/attempts"
  : > "$rnsquad_deps_fixture/args"
  : > "$rnsquad_deps_fixture/delays"
  PATH="$rnsquad_deps_fixture:$PATH" \
    RNSQUAD_DEPS_SUCCEED_ON="$succeed_on" \
    RNSQUAD_DEPS_ATTEMPTS_FILE="$rnsquad_deps_fixture/attempts" \
    RNSQUAD_DEPS_ARGS_FILE="$rnsquad_deps_fixture/args" \
    RNSQUAD_DEPS_DELAYS_FILE="$rnsquad_deps_fixture/delays" \
    /bin/sh -c "$rnsquad_deps_command"
  status=$?
  actual_attempts=$(cat "$rnsquad_deps_fixture/attempts")
  actual_delays=$(tr '\n' ',' < "$rnsquad_deps_fixture/delays")
  unexpected_args=$(grep -Fvx \
    'add ioredis@5.10.1 uuid@14.0.0 --exact --network-timeout 600000' \
    "$rnsquad_deps_fixture/args" || true)
  [ "$status" -eq "$expected_status" ] ||
    fail "RNSquadJS dependency retry case $succeed_on returned $status instead of $expected_status"
  [ "$actual_attempts" -eq "$expected_attempts" ] ||
    fail "RNSquadJS dependency retry case $succeed_on made $actual_attempts attempt(s) instead of $expected_attempts"
  [ "$actual_delays" = "$expected_delays" ] ||
    fail "RNSquadJS dependency retry case $succeed_on used delays '$actual_delays' instead of '$expected_delays'"
  [ -z "$unexpected_args" ] ||
    fail "RNSquadJS dependency retry changed the pinned yarn arguments: $unexpected_args"
}

assert_rnsquad_deps_retry 1 0 1 ''
assert_rnsquad_deps_retry 2 0 2 '5,'
assert_rnsquad_deps_retry 3 0 3 '5,10,'
assert_rnsquad_deps_retry 4 1 3 '5,10,'
cleanup_rnsquad_deps_fixture
trap - EXIT

echo "test-ci-runner-strategy: OK — every ci and deploy job runs on ${HOSTED_IMAGE}; ci is master-only, tk104 follows dev"
