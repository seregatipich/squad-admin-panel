#!/usr/bin/env bash
# ci-reuse-deploy-images.sh — let the `images` job of ci.yml reuse the release images the stand
# deploy already built for the same commit, instead of building them a second time.
#
# A promotion fast-forwards master to a dev tip whose push started deploy.yml, which builds and pushes
# ghcr.io/<owner>/squad-panel-<image>:<sha> for exactly this commit. Building them again in ci cost
# ~180-230 s whenever source layers changed (the deploy's layer cache is not pushed yet while both
# run at once), and made the images job the slowest job of the run.
#
# The script waits, bounded, for the images to appear while a deploy run for this commit exists, pulls
# them and tags them like docker-bake.hcl does (squad-panel/<image>:<sha>) so the smoke tests run
# unchanged, and writes `reuse=true|false` to $GITHUB_OUTPUT. It never fails the job: with no deploy run
# for the commit (a docs-only push, a dispatch), a deploy that finished without the images (failed or
# cancelled), a timeout or a failed pull, `reuse=false` makes ci build the images as before.
#
# Environment:
#   GITHUB_SHA, GITHUB_REPOSITORY  the commit and repository (set by GitHub Actions); GH_TOKEN for gh
#   GITHUB_OUTPUT                  where reuse=... is written (default: stdout)
#   REUSE_IMAGES                   space-separated images the smoke tests need (default: api workers)
#   IMAGE_PREFIX                   registry prefix (default: ghcr.io/seregatipich/squad-panel)
#   REUSE_MAX_POLLS, REUSE_POLL_SECS  wait budget (default 72 polls of 5 s = 6 min)
set -uo pipefail

: "${GITHUB_SHA:?GITHUB_SHA is not set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

prefix=${IMAGE_PREFIX:-ghcr.io/seregatipich/squad-panel}
read -r -a images <<<"${REUSE_IMAGES:-api workers}"
max_polls=${REUSE_MAX_POLLS:-72}
poll_secs=${REUSE_POLL_SECS:-5}
output=${GITHUB_OUTPUT:-/dev/stdout}

reuse=false

images_exist() {
  local image
  for image in "${images[@]}"; do
    docker buildx imagetools inspect "${prefix}-${image}:${GITHUB_SHA}" >/dev/null 2>&1 || return 1
  done
}

pull_and_tag() {
  local image
  for image in "${images[@]}"; do
    docker pull --quiet "${prefix}-${image}:${GITHUB_SHA}" >/dev/null &&
      docker tag "${prefix}-${image}:${GITHUB_SHA}" "squad-panel/${image}:${GITHUB_SHA}" || return 1
  done
}

settled=false
for ((poll = 0; poll < max_polls; poll++)); do
  deploy_run=$(gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/deploy.yml/runs?head_sha=${GITHUB_SHA}&per_page=1" \
    --jq '.workflow_runs[0] // empty | .status' 2>/dev/null || true)
  if [[ -z "${deploy_run}" ]]; then
    echo "no deploy run for ${GITHUB_SHA}: the images are built here"
    settled=true
    break
  fi
  if images_exist; then
    settled=true
    if pull_and_tag; then
      echo "reusing the images of the stand deploy for ${GITHUB_SHA}: ${images[*]}"
      reuse=true
    else
      echo "could not pull the deploy's images: they are built here"
    fi
    break
  fi
  if [[ "${deploy_run}" == completed ]]; then
    echo "the deploy run for ${GITHUB_SHA} finished without these images: they are built here"
    settled=true
    break
  fi
  sleep "${poll_secs}"
done

if [[ "${settled}" != true ]]; then
  echo "the deploy did not publish the images within $((max_polls * poll_secs)) s: they are built here"
fi
echo "reuse=${reuse}" >>"${output}"
exit 0
