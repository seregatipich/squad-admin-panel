#!/usr/bin/env bash
# test-ci-reuse-deploy-images.sh — contract test for scripts/ci-reuse-deploy-images.sh with stubbed
# `gh` and `docker`: the images job reuses the stand deploy's images only when they exist (waiting a
# bounded time while the deploy runs), tags them the way docker-bake.hcl does, and in every other
# case reports reuse=false so ci builds the images itself. Run: bash scripts/test-ci-reuse-deploy-images.sh
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
script="$repo_root/scripts/ci-reuse-deploy-images.sh"

fail() {
  echo "test-ci-reuse-deploy-images: FAIL — $1" >&2
  exit 1
}

fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin"

# gh: prints $GH_STATUS (empty = no deploy run) and counts its calls.
cat >"$fixture/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo x >>"$STUB_DIR/gh.calls"
n=$(wc -l <"$STUB_DIR/gh.calls" | tr -d ' ')
# GH_STATUS_AFTER=<n>:<status> switches the reported status from the n-th call on.
if [[ -n "${GH_STATUS_AFTER:-}" && "$n" -ge "${GH_STATUS_AFTER%%:*}" ]]; then
  printf '%s' "${GH_STATUS_AFTER#*:}"
else
  printf '%s' "${GH_STATUS:-}"
fi
EOF

# docker: imagetools inspect succeeds from the PRESENT_AFTER-th inspect call on; pull fails when PULL_FAIL=1.
cat >"$fixture/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$STUB_DIR/docker.log"
case "$1 $2" in
"buildx imagetools")
  echo x >>"$STUB_DIR/inspect.calls"
  n=$(wc -l <"$STUB_DIR/inspect.calls" | tr -d ' ')
  # a poll stops at the first missing image, so a missing-image poll is one inspect call
  [[ "${PRESENT_AFTER:-0}" -gt 0 && "$n" -ge "${PRESENT_AFTER}" ]] && exit 0
  exit 1
  ;;
esac
[[ "$1" == pull && "${PULL_FAIL:-0}" == 1 ]] && exit 1
exit 0
EOF
chmod +x "$fixture/bin/gh" "$fixture/bin/docker"

sha=0123456789abcdef0123456789abcdef01234567
run_case() { # <name> -> sets output, log; env vars of the case are exported by the caller
  : >"$fixture/gh.calls"
  : >"$fixture/inspect.calls"
  : >"$fixture/docker.log"
  : >"$fixture/out"
  STUB_DIR="$fixture" PATH="$fixture/bin:$PATH" GITHUB_SHA="$sha" GITHUB_REPOSITORY=o/r \
    GITHUB_OUTPUT="$fixture/out" REUSE_POLL_SECS=0 REUSE_MAX_POLLS=${REUSE_MAX_POLLS:-5} \
    bash "$script" >"$fixture/stdout" 2>&1
  status=$?
  [[ "$status" -eq 0 ]] || fail "$1: the script exited $status instead of 0 ($(cat "$fixture/stdout"))"
}
reuse_is() { grep -Fxq "reuse=$1" "$fixture/out" || fail "$2: expected reuse=$1, got '$(cat "$fixture/out")'"; }
pulled() { grep -c '^pull ' "$fixture/docker.log"; }

# --- No deploy run for the commit (docs-only push, dispatch): build, and do not touch the registry. ---
GH_STATUS='' run_case 'no deploy run'
reuse_is false 'no deploy run'
[ "$(cat "$fixture/inspect.calls" | wc -l | tr -d ' ')" = 0 ] || fail 'no deploy run: the registry was queried'
grep -q 'built here' "$fixture/stdout" || fail 'no deploy run: no message about building'

# --- The images are already there: reuse them, tagged the way docker-bake.hcl tags its builds. ---
GH_STATUS=completed PRESENT_AFTER=1 run_case 'images present'
reuse_is true 'images present'
[ "$(pulled)" = 2 ] || fail "images present: pulled $(pulled) images instead of api and workers"
for image in api workers; do
  grep -Fxq "tag ghcr.io/seregatipich/squad-panel-$image:$sha squad-panel/$image:$sha" "$fixture/docker.log" ||
    fail "images present: $image is not tagged squad-panel/$image:<sha>"
done

# --- The deploy is still building: wait for the images, then reuse them. ---
GH_STATUS=in_progress PRESENT_AFTER=3 run_case 'images appear while waiting'
reuse_is true 'images appear while waiting'
[ "$(wc -l <"$fixture/gh.calls" | tr -d ' ')" = 3 ] || fail 'images appear while waiting: did not poll three times'

# --- The deploy finished without the images (failed or cancelled build): stop waiting, build. ---
GH_STATUS_AFTER='2:completed' GH_STATUS=in_progress PRESENT_AFTER=0 REUSE_MAX_POLLS=50 run_case 'deploy ended without images'
reuse_is false 'deploy ended without images'
[ "$(wc -l <"$fixture/gh.calls" | tr -d ' ')" = 2 ] || fail 'deploy ended without images: kept waiting after the deploy completed'
[ "$(pulled)" = 0 ] || fail 'deploy ended without images: pulled something'

# --- A failed pull falls back to building. ---
GH_STATUS=completed PRESENT_AFTER=1 PULL_FAIL=1 run_case 'pull fails'
reuse_is false 'pull fails'
grep -q 'could not pull' "$fixture/stdout" || fail 'pull fails: no message'

# --- The wait is bounded. ---
GH_STATUS=in_progress PRESENT_AFTER=0 REUSE_MAX_POLLS=4 run_case 'timeout'
reuse_is false 'timeout'
[ "$(wc -l <"$fixture/gh.calls" | tr -d ' ')" = 4 ] || fail 'timeout: did not stop after the poll budget'
grep -q 'did not publish the images within' "$fixture/stdout" || fail 'timeout: no message'

# --- A broken gh (API error, no token) is not a deploy run: build. ---
cat >"$fixture/bin/gh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
GH_STATUS='' run_case 'gh fails'
reuse_is false 'gh fails'

echo "test-ci-reuse-deploy-images: OK — reuse waits boundedly for the deploy's images, tags them like bake, and falls back to building in every other case"
