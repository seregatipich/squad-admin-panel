#!/usr/bin/env bash
# test-ci-runner-strategy.sh — держать все задачи на собственных раннерах
# проекта, выбираемых группой.
#
# Раньше здесь было обратное правило: проверка на эфемерных GitHub-раннерах,
# а свой раннер — только деплою (#286). Проект вернулся на свои раннеры и
# отключил выбор по меткам, чтобы GitHub-раннеры не подмешивались; значит
# `runs-on: self-hosted` больше ни с чем не сопоставляется и объявлять раннер
# можно только группой. Тест следит, чтобы ни одна задача не уехала обратно на
# метку или на GitHub-образ.
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

RUNNER_GROUP='selfhost-group-1'

for job in branch-guard node go docker; do
  block=$(job_block "$ci_workflow" "$job")
  [ -n "$block" ] || fail "required ci job '$job' is missing"
  printf '%s\n' "$block" | grep -Eq "^[[:space:]]*group:[[:space:]]*${RUNNER_GROUP}[[:space:]]*$" ||
    fail "ci job '$job' does not target the '${RUNNER_GROUP}' runner group"
done

node_block=$(job_block "$ci_workflow" node)
printf '%s\n' "$node_block" | grep -Fq 'timeout-minutes: 45' ||
  fail 'node timeout does not cover a full-suite run after a cache miss'

for workflow in "$ci_workflow" "$deploy_workflow"; do
  if grep -Eq '^[[:space:]]*runs-on:[[:space:]]*ubuntu-' "$workflow"; then
    fail "$(basename "$workflow") still pins a GitHub-hosted image"
  fi
  # Выбор по меткам в проекте отключён: задача с `runs-on: self-hosted` не
  # найдёт себе раннер и молча повиснет в очереди.
  if grep -Eq '^[[:space:]]*runs-on:[[:space:]]*self-hosted[[:space:]]*$' "$workflow"; then
    fail "$(basename "$workflow") selects a runner by label instead of by group"
  fi
done

deploy_groups=$(grep -Ec "^[[:space:]]*group:[[:space:]]*${RUNNER_GROUP}[[:space:]]*$" "$deploy_workflow")
[ "$deploy_groups" -ge 1 ] ||
  fail "production deploy no longer targets the '${RUNNER_GROUP}' runner group"

go_block=$(job_block "$ci_workflow" go)
printf '%s\n' "$go_block" | grep -Fq 'GOFLAGS: -buildvcs=false -modcacherw' ||
  fail 'host Go commands may recreate read-only module cache directories'
printf '%s\n' "$go_block" | grep -Eq 'uses:[[:space:]]+actions/setup-go@[0-9a-f]{40}' ||
  fail 'go job does not install Go through a SHA-pinned setup action'
printf '%s\n' "$go_block" | grep -Fq 'cache: false' ||
  fail 'go job still restores an actions/cache archive into a persistent runner directory'
printf '%s\n' "$go_block" | grep -Fq 'name: Очистить и настроить кеши Go' ||
  fail 'go job has no runner-side cache reset and path setup step'
printf '%s\n' "$go_block" | grep -Fq 'cache_root="${RUNNER_TEMP%/}/squad-admin-panel-go-cache"' ||
  fail 'go cache root is not bound to the project inside RUNNER_TEMP'
go_cache_setup_block=$(printf '%s\n' "$go_block" | sed -n '/name: Очистить и настроить кеши Go/,/uses: actions\/setup-go@/p')
printf '%s\n' "$go_cache_setup_block" | grep -Fq '[[ -z "${RUNNER_TEMP:-}" ]]' ||
  fail 'go cache pre-clean does not reject an unresolved RUNNER_TEMP'
printf '%s\n' "$go_cache_setup_block" | grep -Fq 'find "${cache_root}" -xdev -type d -exec chmod u+w {} +' ||
  fail 'go cache pre-clean cannot recover interrupted read-only module directories'
printf '%s\n' "$go_cache_setup_block" | grep -Fq 'find "${cache_root}" -xdev -depth -delete' ||
  fail 'go cache root is not emptied before a remote cache restore'
if printf '%s\n' "$go_cache_setup_block" | grep -Eq 'rm[[:space:]]+-r'; then
  fail 'go cache pre-clean uses recursive rm instead of an exact traversal'
fi

# Go без -modcacherw делает каталоги модулей 0555. Воспроизводим остаток
# жёстко оборванной задачи и доказываем, что точный рецепт pre-clean удаляет
# его, не полагаясь на успевший выполниться `go clean -modcache`.
readonly_fixture_parent=$(mktemp -d)
readonly_fixture_root="${readonly_fixture_parent}/squad-admin-panel-go-cache"
cleanup_readonly_fixture() {
  if [[ -e "${readonly_fixture_root}" || -L "${readonly_fixture_root}" ]]; then
    if [[ -d "${readonly_fixture_root}" && ! -L "${readonly_fixture_root}" ]]; then
      find "${readonly_fixture_root}" -xdev -type d -exec chmod u+w {} + 2>/dev/null || true
    fi
    find "${readonly_fixture_root}" -xdev -depth -delete 2>/dev/null || true
  fi
  rmdir "${readonly_fixture_parent}" 2>/dev/null || true
}
trap cleanup_readonly_fixture EXIT
mkdir -p "${readonly_fixture_root}/modules/example"
: > "${readonly_fixture_root}/modules/example/go.mod"
chmod 0444 "${readonly_fixture_root}/modules/example/go.mod"
chmod 0555 "${readonly_fixture_root}/modules/example" "${readonly_fixture_root}/modules"
find "${readonly_fixture_root}" -xdev -type d -exec chmod u+w {} + ||
  fail 'go cache pre-clean cannot make an interrupted module tree removable'
find "${readonly_fixture_root}" -xdev -depth -delete ||
  fail 'go cache pre-clean cannot delete an interrupted read-only module tree'
[[ ! -e "${readonly_fixture_root}" ]] ||
  fail 'go cache pre-clean left the interrupted module tree behind'
rmdir "${readonly_fixture_parent}"
trap - EXIT

for variable in GO_CACHE_ROOT GOCACHE GOMODCACHE GOPATH GOBIN; do
  printf '%s\n' "$go_block" | grep -Fq "echo \"${variable}=" ||
    fail "go cache setup does not export ${variable} through GITHUB_ENV"
done
printf '%s\n' "$go_block" | grep -Fq '>> "${GITHUB_ENV}"' ||
  fail 'go cache paths are not passed to setup-go and later steps'
printf '%s\n' "$go_block" | grep -Eq 'uses:[[:space:]]+actions/cache/restore@[0-9a-f]{40}' ||
  fail 'go job does not restore its reusable cache through a SHA-pinned action'
printf '%s\n' "$go_block" | grep -Fq 'id: go-cache-restore' ||
  fail 'go cache restore has no stable id for the cache-hit guard'
printf '%s\n' "$go_block" | grep -Eq 'uses:[[:space:]]+actions/cache/save@[0-9a-f]{40}' ||
  fail 'go job does not save its reusable cache before local cleanup'
remote_cache_path='${{ runner.temp }}/squad-admin-panel-go-cache'
[ "$(printf '%s\n' "$go_block" | grep -Fc "$remote_cache_path")" -eq 2 ] ||
  fail 'Go cache restore/save paths differ or are not stable between runs'
cache_key='squad-admin-panel-go-${{ runner.os }}-${{ runner.arch }}-go1.25.13-govuln1.7.0-${{ hashFiles('"'"'apps/bridge/go.sum'"'"') }}'
[ "$(printf '%s\n' "$go_block" | grep -Fc "$cache_key")" -eq 2 ] ||
  fail 'Go cache restore/save keys differ or are not bound to tool and dependency versions'
go_cache_save_block=$(printf '%s\n' "$go_block" | sed -n '/name: Сохранить переиспользуемый кеш Go/,/name: Удалить локальный кеш Go/p')
printf '%s\n' "$go_cache_save_block" | grep -Fq "if: success() && steps.go-cache-restore.outputs.cache-hit != 'true'" ||
  fail 'Go cache may be saved after a failed or partial scan'
printf '%s\n' "$go_block" | grep -Fq 'go install golang.org/x/vuln/cmd/govulncheck@v1.7.0' ||
  fail 'govulncheck is not pinned to the accepted release'
printf '%s\n' "$go_block" | grep -Fq 'go version -m "${GOBIN}/govulncheck"' ||
  fail 'a restored govulncheck binary is not verified through embedded Go module metadata'
printf '%s\n' "$go_block" | grep -Fq 'golang.org/x/vuln[[:space:]]+v1\.7\.0' ||
  fail 'govulncheck metadata verification does not require the pinned module release'
if printf '%s\n' "$go_block" | grep -Fq 'govulncheck@latest'; then
  fail 'govulncheck still changes implicitly between CI runs'
fi
printf '%s\n' "$go_block" | grep -Fq 'name: Удалить локальный кеш Go' ||
  fail 'go job has no exact cache cleanup step'
go_cleanup_block=$(printf '%s\n' "$go_block" | sed -n '/name: Удалить локальный кеш Go/,$p')
printf '%s\n' "$go_cleanup_block" | grep -Fq 'if: always()' ||
  fail 'go cache cleanup is skipped after a failed check'
printf '%s\n' "$go_cleanup_block" | grep -Fq 'go clean -cache -modcache' ||
  fail 'go job does not clean its exact build and module caches'
printf '%s\n' "$go_cleanup_block" | grep -Fq '"${GO_CACHE_ROOT}" != "${expected_root}"' ||
  fail 'go cache cleanup does not validate its exact project-scoped root'
printf '%s\n' "$go_cleanup_block" | grep -Fq '"${GOPATH}" != "${GO_CACHE_ROOT}/workspace"' ||
  fail 'go cache cleanup does not validate its isolated GOPATH'
printf '%s\n' "$go_cleanup_block" | grep -Fq '"${GOBIN}" != "${GO_CACHE_ROOT}/bin"' ||
  fail 'go cache cleanup does not validate its isolated GOBIN'
printf '%s\n' "$go_cleanup_block" | grep -Fq 'find "${GO_CACHE_ROOT}" -xdev -type d -exec chmod u+w {} +' ||
  fail 'go cache cleanup cannot recover read-only module directories'
printf '%s\n' "$go_cleanup_block" | grep -Fq 'find "${GO_CACHE_ROOT}" -xdev -depth -delete' ||
  fail 'go cache cleanup does not remove its exact project-scoped root'
if printf '%s\n' "$go_cleanup_block" | grep -Eq 'rm[[:space:]]+-r'; then
  fail 'go cache cleanup uses recursive rm instead of a validated exact traversal'
fi
if printf '%s\n' "$go_block" | grep -Fq 'cache-dependency-path:'; then
  fail 'go job still configures the conflicting setup-go dependency cache'
fi

grep -Fq 'cancel-in-progress: true' "$ci_workflow" ||
  fail 'superseded ci runs still queue behind each other on a single-machine group'

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

echo "test-ci-runner-strategy: OK — every ci and deploy job targets the '${RUNNER_GROUP}' runner group"
