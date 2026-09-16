#!/usr/bin/env bash
# test-ci-runner-strategy.sh — keep verification on ephemeral GitHub-hosted VMs
# and the production deploy on the repository's own tk104 runner.
#
# The project first ran verification hosted and deployed from its own runner
# (#286), then moved everything onto an organization runner group. That group
# belonged to the `breaking-squad` organization; the repository now lives on a
# personal account, which has no runner groups at all, and it is public, so
# hosted minutes are free while any verification job on the production host
# would widen what outside code can reach. The test fails if a ci job leaves
# the hosted image, if a deploy job leaves the labelled tk104 runner or its
# `production` environment, or if any workflow still selects a runner group.
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

[ -f "$ci_workflow" ] || fail 'ci workflow is missing'
[ -f "$deploy_workflow" ] || fail 'deploy workflow is missing'

grep -Fq 'branches: [master, dev]' "$ci_workflow" ||
  fail 'ci push trigger is not restricted to trusted integration branches'

HOSTED_IMAGE='ubuntu-24.04'
DEPLOY_RUNNER='[self-hosted, tk104-deploy]'

for job in branch-guard node go docker; do
  block=$(job_block "$ci_workflow" "$job")
  [ -n "$block" ] || fail "required ci job '$job' is missing"
  printf '%s\n' "$block" | grep -Fxq "    runs-on: ${HOSTED_IMAGE}" ||
    fail "ci job '$job' does not use the pinned GitHub-hosted image ${HOSTED_IMAGE}"
done

if grep -Eq '^[[:space:]]*runs-on:.*self-hosted' "$ci_workflow"; then
  fail 'ci still contains a job on a self-hosted runner'
fi

for workflow in "$ci_workflow" "$deploy_workflow"; do
  # A personal-account repository has no runner groups: a job that selects one
  # waits in the queue forever without an error.
  if grep -Eq '^[[:space:]]*runs-on:[[:space:]]*$' "$workflow"; then
    fail "$(basename "$workflow") still selects a runner group instead of a hosted image or labels"
  fi
done

deploy_jobs=$(grep -Ec '^  [a-zA-Z0-9_-]+:$' <(sed -n '/^jobs:$/,$p' "$deploy_workflow"))
[ "$deploy_jobs" -ge 1 ] || fail 'deploy workflow declares no jobs'
while IFS= read -r job; do
  block=$(job_block "$deploy_workflow" "$job")
  printf '%s\n' "$block" | grep -Fxq "    runs-on: ${DEPLOY_RUNNER}" ||
    fail "deploy job '$job' does not target the labelled tk104 deploy runner"
  printf '%s\n' "$block" | grep -Fxq '    environment: production' ||
    fail "deploy job '$job' can read deploy secrets outside the production environment"
  printf '%s\n' "$block" | grep -Fq "github.repository == 'seregatipich/squad-admin-panel'" ||
    fail "deploy job '$job' would also run in a fork"
done < <(sed -n '/^jobs:$/,$p' "$deploy_workflow" | sed -n 's/^  \([a-zA-Z0-9_-]*\):$/\1/p')
if grep -Eq '^[[:space:]]*runs-on:[[:space:]]*ubuntu-' "$deploy_workflow"; then
  fail 'production deploy must not move to a GitHub-hosted runner'
fi

node_block=$(job_block "$ci_workflow" node)
printf '%s\n' "$node_block" | grep -Fq 'timeout-minutes: 45' ||
  fail 'node timeout does not cover a cold hosted full-suite run'

go_block=$(job_block "$ci_workflow" go)
printf '%s\n' "$go_block" | grep -Eq 'uses:[[:space:]]+actions/setup-go@[0-9a-f]{40}' ||
  fail 'go job does not install Go through a SHA-pinned setup action'
printf '%s\n' "$go_block" | grep -Fq 'cache-dependency-path: apps/bridge/go.sum' ||
  fail 'go cache is not keyed by the bridge module dependency file'
printf '%s\n' "$go_block" | grep -Fxq '      - run: go test -race -count=1 ./...' ||
  fail 'go job does not run the race detector directly on the hosted VM'
if printf '%s\n' "$go_block" | grep -Eq 'docker run|^[[:space:]]+container:'; then
  fail 'go job still carries the self-hosted container workaround'
fi
printf '%s\n' "$go_block" | grep -Fq 'go install golang.org/x/vuln/cmd/govulncheck@v1.7.0' ||
  fail 'govulncheck is not pinned to the accepted release'
if printf '%s\n' "$go_block" | grep -Fq 'govulncheck@latest'; then
  fail 'govulncheck still changes implicitly between CI runs'
fi
printf '%s\n' "$go_block" | grep -Fq 'if ldd bin/panel-host-bridge' ||
  fail 'go job no longer proves the bridge binary is statically linked'

grep -Fq 'cancel-in-progress: true' "$ci_workflow" ||
  fail 'superseded ci runs are not cancelled'

branch_guard=$(job_block "$ci_workflow" branch-guard)
printf '%s\n' "$branch_guard" | grep -Fq 'bash scripts/test-ci-runner-strategy.sh' ||
  fail 'branch-guard does not execute this regression test'

node_block=$(job_block "$ci_workflow" node)
printf '%s\n' "$node_block" | grep -Fq -- '--tmpfs /var/lib/postgresql/data:rw,size=1g' ||
  fail 'Postgres service may leak its image-declared anonymous volume'
printf '%s\n' "$node_block" | grep -Fq -- '--tmpfs /data:rw,size=128m' ||
  fail 'Redis service may leak its image-declared anonymous volume'
if printf '%s\n' "$node_block" | grep -Eq 'docker (system|volume|builder) prune'; then
  fail 'node job contains a broad Docker cleanup'
fi

docker_block=$(job_block "$ci_workflow" docker)
printf '%s\n' "$docker_block" | grep -Fq 'CI_IMAGE_TAG: ci-${{ github.run_id }}-${{ github.run_attempt }}' ||
  fail 'docker images are not bound to the exact workflow run'
printf '%s\n' "$docker_block" | grep -Fq 'id: buildx' ||
  fail 'docker job does not expose its isolated builder name'
printf '%s\n' "$docker_block" | grep -Fq 'cleanup: true' ||
  fail 'docker job does not remove its isolated builder cache'
buildx_count=$(printf '%s\n' "$docker_block" | grep -Fc 'docker buildx build --builder "${{ steps.buildx.outputs.name }}" --load')
[ "$buildx_count" -eq 5 ] ||
  fail "docker job has $buildx_count isolated builds instead of 5"
printf '%s\n' "$docker_block" | grep -Fq 'CI_BUILDX_BUILDER: ${{ steps.buildx.outputs.name }}' ||
  fail 'backup round-trip does not receive the isolated builder name'
if printf '%s\n' "$docker_block" | grep -Eq 'run:[[:space:]]+docker build[[:space:]]'; then
  fail 'docker job still writes intermediate cache into the persistent daemon builder'
fi
printf '%s\n' "$docker_block" | grep -Fq 'name: remove exact CI images' ||
  fail 'docker job has no exact image cleanup step'
printf '%s\n' "$docker_block" | grep -Fq 'if: always()' ||
  fail 'docker image cleanup is skipped after a failed build'
printf '%s\n' "$docker_block" | grep -Fq 'docker image rm --force' ||
  fail 'docker job does not remove its exact images'
cleanup_block=$(printf '%s\n' "$docker_block" | sed -n '/name: remove exact CI images/,$p')
cleanup_tag_count=$(printf '%s\n' "$cleanup_block" | grep -Fc ':${CI_IMAGE_TAG}"')
[ "$cleanup_tag_count" -eq 5 ] ||
  fail "docker cleanup has $cleanup_tag_count run-scoped tags instead of 5"
for image in \
  squad-admin-panel/api \
  squad-admin-panel/worker-log-ingest \
  squad-admin-panel/worker-rcon \
  squad-panel/rnsquadjs \
  squad-admin-panel/web
do
  printf '%s\n' "$cleanup_block" | grep -Fq "\"${image}:\${CI_IMAGE_TAG}\"" ||
    fail "docker cleanup omits ${image}"
done
if printf '%s\n' "$docker_block" | grep -Eq 'squad-(admin-panel|panel)/[^:[:space:]]+:ci([[:space:]".]|$)'; then
  fail 'docker job still uses a shared :ci tag'
fi

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

echo "test-ci-runner-strategy: OK — ci runs on ${HOSTED_IMAGE}, every deploy job on ${DEPLOY_RUNNER} in production"
