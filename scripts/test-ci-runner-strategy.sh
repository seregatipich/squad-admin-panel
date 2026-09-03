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
printf '%s\n' "$go_block" | grep -Eq 'uses:[[:space:]]+actions/setup-go@[0-9a-f]{40}' ||
  fail 'go job does not install Go through a SHA-pinned setup action'
printf '%s\n' "$go_block" | grep -Fq 'cache: false' ||
  fail 'go job still restores an actions/cache archive into a persistent runner directory'
printf '%s\n' "$go_block" | grep -Fq 'name: Настроить кеши Go точной попытки' ||
  fail 'go job has no runner-side cache path setup step'
printf '%s\n' "$go_block" | grep -Fq 'cache_root="${RUNNER_TEMP}/squad-admin-panel-go-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"' ||
  fail 'go cache root is not bound to the exact workflow attempt on the runner'
for variable in GO_CACHE_ROOT GOCACHE GOMODCACHE; do
  printf '%s\n' "$go_block" | grep -Fq "echo \"${variable}=" ||
    fail "go cache setup does not export ${variable} through GITHUB_ENV"
done
printf '%s\n' "$go_block" | grep -Fq '>> "${GITHUB_ENV}"' ||
  fail 'go cache paths are not passed to setup-go and later steps'
if printf '%s\n' "$go_block" | grep -Fq '${{ runner.temp }}'; then
  fail 'go job evaluates runner.temp before the runner-side setup step'
fi
printf '%s\n' "$go_block" | grep -Fq 'name: Удалить кеши Go точной попытки' ||
  fail 'go job has no exact cache cleanup step'
go_cleanup_block=$(printf '%s\n' "$go_block" | sed -n '/name: Удалить кеши Go точной попытки/,$p')
printf '%s\n' "$go_cleanup_block" | grep -Fq 'if: always()' ||
  fail 'go cache cleanup is skipped after a failed check'
printf '%s\n' "$go_cleanup_block" | grep -Fq 'go clean -cache -modcache' ||
  fail 'go job does not clean its exact build and module caches'
printf '%s\n' "$go_cleanup_block" | grep -Fq '"${GO_CACHE_ROOT}" != "${expected_root}"' ||
  fail 'go cache cleanup does not validate its exact run-scoped root'
printf '%s\n' "$go_cleanup_block" | grep -Fq 'find "${GO_CACHE_ROOT}" -depth -delete' ||
  fail 'go cache cleanup does not remove its exact run-scoped root'
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

echo "test-ci-runner-strategy: OK — every ci and deploy job targets the '${RUNNER_GROUP}' runner group"
