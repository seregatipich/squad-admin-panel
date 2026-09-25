#!/usr/bin/env bash
# Deploy one release to the tk104 dev stand. Runs ON tk104 from the app
# directory, with .env.tk104 present. scripts/tk104-deploy-entry.sh calls it
# for every push to dev, scripts/rollback-tk104.sh for a rollback. Idempotent:
# safe to re-run.
#
# Nothing is built here. The deploy workflow pushes the api, web, workers and
# caddy images to ghcr.io and passes their digests; this script records the
# release in .release.env (the one before it in .release.prev.env) and touches
# only what differs from the running release:
#
#   nothing differs (docs, tests)  -> exit before any Docker call
#   an image differs               -> pull that image, unless already present
#   packages/db/drizzle differs    -> pg_dump into $BACKUP_DIR, then run the
#                                     migrator; a failure stops the deploy
#                                     before any app container is replaced
#
# then `compose up -d --remove-orphans`, which recreates only the services
# whose image or configuration changed, waits for exactly those to become
# healthy, and probes /health through Caddy.
#
# Environment:
#   RELEASE_SHA       required — the commit being deployed
#   API_IMAGE, WEB_IMAGE, WORKERS_IMAGE, CADDY_IMAGE
#                     required — image references, for a release
#                     ghcr.io/seregatipich/squad-panel-<image>@sha256:<digest>
#   DEPLOY_BUILD=1    build the images on this host instead of pulling them
#                     (scripts/dev-deploy-tk104.sh); the references then
#                     default to $PANEL_IMAGE_REPO-<image>:$RELEASE_SHA
#   PANEL_IMAGE_REPO  default ghcr.io/seregatipich/squad-panel
#   BACKUP_DIR        pre-migration dumps (default ~/backups); the newest
#                     KEEP_BACKUPS (default 5) are kept
#   HEALTH_TIMEOUT    seconds to wait for recreated services (default 180)
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/squad-admin-panel}"
PANEL_IMAGE_REPO="${PANEL_IMAGE_REPO:-ghcr.io/seregatipich/squad-panel}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
COMPOSE_FILE="compose.tk104.yml"
BUILD_FILE="compose.tk104.build.yml"
ENV_FILE=".env.tk104"
RELEASE_FILE=".release.env"
PREVIOUS_FILE=".release.prev.env"
NEXT_FILE=".release.next.env"
# Release-file key and image name of each panel image, index for index.
IMAGE_KEYS=(API_IMAGE WEB_IMAGE WORKERS_IMAGE CADDY_IMAGE)
IMAGE_NAMES=(api web workers caddy-tk104)

fatal() {
  echo "fatal: $*" >&2
  exit 1
}

cd "$APP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  fatal "$APP_DIR/$ENV_FILE is missing (copy .env.example, fill the tk104 secrets incl. DUCKDNS_TOKEN)"
fi
if [[ ! "${RELEASE_SHA:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  fatal "RELEASE_SHA must name the release (got '${RELEASE_SHA:-}')"
fi
for i in "${!IMAGE_KEYS[@]}"; do
  key="${IMAGE_KEYS[$i]}"
  if [[ "${DEPLOY_BUILD:-}" == 1 && -z "${!key:-}" ]]; then
    printf -v "$key" '%s' "${PANEL_IMAGE_REPO}-${IMAGE_NAMES[$i]}:${RELEASE_SHA}"
  fi
  # The references end up in an env file compose interpolates, so only plain
  # registry/name characters and a tag or digest get through.
  if [[ ! "${!key:-}" =~ ^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]{1,128}|@sha256:[0-9a-f]{64})$ ]]; then
    fatal "$key must be an image reference such as ${PANEL_IMAGE_REPO}-${IMAGE_NAMES[$i]}@sha256:<digest> (got '${!key:-}')"
  fi
done
# Compose prefers the process environment over any --env-file, so a stray
# APP_VERSION or CADDYFILE_SHA in the caller's shell would override the
# release file below; the image variables are written there verbatim.
unset APP_VERSION CADDYFILE_SHA
for dependency in packages/db/drizzle docker/Caddyfile.tk104 "$COMPOSE_FILE"; do
  [[ -e "$dependency" ]] || fatal "$APP_DIR/$dependency is missing"
done

# Prints KEY's value from a release file, or nothing. The files are data this
# script writes, so they are read rather than sourced.
release_value() {
  [[ -f "$1" ]] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

# /health reports the commit that introduced the running api image. A release
# that keeps the api image keeps that version, so the api is not recreated just
# to report a new SHA; a rollback gets back the version recorded with its image.
app_version="$RELEASE_SHA"
for file in "$RELEASE_FILE" "$PREVIOUS_FILE"; do
  if [[ "$(release_value "$file" API_IMAGE)" == "$API_IMAGE" ]]; then
    recorded="$(release_value "$file" APP_VERSION)"
    app_version="${recorded:-$RELEASE_SHA}"
    break
  fi
done

migrations_sha="$(
  cd packages/db/drizzle
  find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
)"
caddyfile_sha="$(sha256sum < docker/Caddyfile.tk104 | cut -d' ' -f1)"
# Compose recreates a service whose configuration changed on its own, but the
# early exit below must not skip an edited compose file or .env.tk104.
compose_config_sha="$(cat "$COMPOSE_FILE" "$ENV_FILE" | sha256sum | cut -d' ' -f1)"

trap 'rm -f "$NEXT_FILE"' EXIT
{
  echo "# Release running on tk104, written by scripts/deploy-tk104.sh. Compose reads it after .env.tk104."
  echo "RELEASE_SHA=$RELEASE_SHA"
  echo "APP_VERSION=$app_version"
  for key in "${IMAGE_KEYS[@]}"; do echo "$key=${!key}"; done
  echo "CADDYFILE_SHA=$caddyfile_sha"
  echo "MIGRATIONS_SHA=$migrations_sha"
  echo "COMPOSE_CONFIG_SHA=$compose_config_sha"
} > "$NEXT_FILE"

# A host build reuses tags, so equal references prove nothing about content.
if [[ "${DEPLOY_BUILD:-}" != 1 && -f "$RELEASE_FILE" ]] &&
  cmp -s <(grep -v '^RELEASE_SHA=' "$RELEASE_FILE") <(grep -v '^RELEASE_SHA=' "$NEXT_FILE"); then
  mv -f "$NEXT_FILE" "$RELEASE_FILE"
  echo "==> ${RELEASE_SHA} changes no image and no configuration: nothing to do (APP_VERSION=${app_version})"
  exit 0
fi

# Every compose call reads .env.tk104 and then the release file. Compose merges
# several --env-file flags only since 2.17; an older one silently reads just
# the last file and would recreate every service without the .env.tk104
# secrets, so refuse before touching anything.
compose_version="$(docker compose version --short 2>/dev/null || true)"
compose_version="${compose_version#v}"
if [[ ! "$compose_version" =~ ^([0-9]+)\.([0-9]+) ]] ||
  ((BASH_REMATCH[1] < 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] < 17))); then
  fatal "Docker Compose 2.17+ is required to merge $ENV_FILE and $RELEASE_FILE (found '${compose_version:-none}')"
fi

compose() {
  docker compose --env-file "$ENV_FILE" --env-file "$NEXT_FILE" -f "$COMPOSE_FILE" "$@"
}

# Is KEY different in the release being deployed? Everything is, on a host
# that has no release recorded yet.
changed() {
  [[ "$(release_value "$RELEASE_FILE" "$1")" != "$(release_value "$NEXT_FILE" "$1")" ]]
}

# Waits until every SERVICE is running and, if it has a healthcheck, healthy.
wait_until_ready() {
  local attempt status service state pending=""
  for ((attempt = 1; attempt <= HEALTH_TIMEOUT; attempt++)); do
    status="$(compose ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null || true)"
    pending=""
    for service in "$@"; do
      state="$(awk -v service="$service" '$1 == service { print $2 "/" $3; exit }' <<<"$status")"
      if [[ "$state" != running/healthy && "$state" != running/ ]]; then
        pending+=" ${service}(${state:-missing})"
      fi
    done
    if [[ -z "$pending" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "fatal: not ready after ${HEALTH_TIMEOUT}s:${pending}" >&2
  return 1
}

if [[ "${DEPLOY_BUILD:-}" == 1 ]]; then
  echo "==> Building the images for ${RELEASE_SHA} on this host"
  compose -f "$BUILD_FILE" build
else
  for i in "${!IMAGE_KEYS[@]}"; do
    key="${IMAGE_KEYS[$i]}"
    changed "$key" || continue
    if docker image inspect "${!key}" >/dev/null 2>&1; then
      echo "==> ${IMAGE_NAMES[$i]}: ${!key} is already on this host"
    else
      echo "==> Pulling ${IMAGE_NAMES[$i]}: ${!key}"
      docker pull --quiet "${!key}"
    fi
  done
fi

if changed MIGRATIONS_SHA; then
  echo "==> packages/db/drizzle changed: backing up the database before migrating"
  compose up -d postgres
  wait_until_ready postgres
  mkdir -p "$BACKUP_DIR"
  backup="$BACKUP_DIR/panel-$(date -u +%Y%m%dT%H%M%SZ)-${RELEASE_SHA:0:12}.dump"
  if ! compose exec -T postgres pg_dump -U admin -d admin -Fc > "$backup.partial" ||
    [[ ! -s "$backup.partial" ]]; then
    rm -f "$backup.partial"
    fatal "database backup failed; nothing was migrated or recreated"
  fi
  mv -f "$backup.partial" "$backup"
  echo "==> Backup written to $backup"
  # The timestamp leads the name, so glob order is age order.
  set -- "$BACKUP_DIR"/panel-*.dump
  while (($# > KEEP_BACKUPS)); do
    rm -f -- "$1"
    shift
  done
  echo "==> Running migrations"
  if ! compose run --rm -T migrator; then
    fatal "migrations failed; no app container was recreated (backup: $backup)"
  fi
fi

# Service and container ID of every container, before and after `up`: a
# service whose ID changed (or that is new) was recreated.
containers() {
  compose ps -a --format '{{.Service}} {{.ID}}' 2>/dev/null | LC_ALL=C sort || true
}
before="$(containers)"
echo "==> Starting ${RELEASE_SHA}"
compose up -d --remove-orphans
after="$(containers)"
recreated="$(
  LC_ALL=C comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") |
    awk 'NF { print $1 }' | LC_ALL=C sort -u | tr '\n' ' '
)"
recreated="${recreated% }"

if [[ -n "$recreated" ]]; then
  echo "==> Recreated: ${recreated}; waiting for them to be ready"
  # Word splitting is intended: service names contain no spaces.
  # shellcheck disable=SC2086
  wait_until_ready $recreated
else
  echo "==> Every container already matched the release"
fi

echo "==> Local health probe (through Caddy on 443)"
# Caddy serves TLS only for the tk104.duckdns.org SNI (DNS-01 cert), so probe
# 127.0.0.1 with the real host name via --resolve instead of https://localhost.
#
# Retry rather than probe once: a recreated caddy needs a moment to bind 443
# and finish its TLS handshake, and a recreated api is only routed again after
# Caddy's next active health check. A single-shot probe raced exactly that —
# run 31948383567 failed with curl exit 35 140 ms after caddy started, while
# the stack was healthy. The probe also insists on the recorded APP_VERSION, so
# an api that silently kept the old container cannot pass for the new release.
probe_status=0
body=""
for _ in $(seq 1 20); do
  probe_status=0
  body="$(curl -fsk --resolve tk104.duckdns.org:443:127.0.0.1 https://tk104.duckdns.org/health \
    --max-time 10)" || probe_status=$?
  if [[ "$probe_status" -eq 0 ]]; then
    [[ "$body" == *"\"version\":\"${app_version}\""* ]] && break
    probe_status=1
  fi
  sleep 2
done
if [[ "$probe_status" -ne 0 ]]; then
  echo "fatal: health probe through Caddy failed after 20 attempts (curl exit $probe_status, expected version ${app_version}, last response: ${body:-none})" >&2
  exit "$probe_status"
fi
echo "caddy->api /health: version ${app_version}"

echo "==> Container status"
compose ps

echo "==> Recording release ${RELEASE_SHA}"
# A failed deploy never gets here: .release.env keeps the last good release,
# and the next deploy compares against it and redoes whatever is missing.
if [[ -f "$RELEASE_FILE" ]]; then
  mv -f "$RELEASE_FILE" "$PREVIOUS_FILE"
fi
mv -f "$NEXT_FILE" "$RELEASE_FILE"

echo "==> Removing panel images other than the running and the previous release"
# A rollback further back pulls its digest from ghcr.io again. `docker image
# rm` refuses images a container still uses, so a failure here is harmless.
keep_ids=" "
for file in "$RELEASE_FILE" "$PREVIOUS_FILE"; do
  for key in "${IMAGE_KEYS[@]}"; do
    reference="$(release_value "$file" "$key")"
    [[ -n "$reference" ]] || continue
    id="$(docker image inspect --format '{{.Id}}' "$reference" 2>/dev/null || true)"
    if [[ -n "$id" ]]; then
      keep_ids+="$id "
    fi
  done
done
for key in "${IMAGE_KEYS[@]}"; do
  reference="${!key}"
  repository="${reference%@*}"
  repository="${repository%:*}"
  { docker image ls --quiet --no-trunc "$repository" 2>/dev/null || true; } | LC_ALL=C sort -u |
    while IFS= read -r id; do
      [[ "$keep_ids" == *" $id "* ]] || docker image rm "$id" >/dev/null 2>&1 || true
    done
done

echo "==> ${RELEASE_SHA} is live on https://tk104.duckdns.org/ (APP_VERSION=${app_version}; recreated: ${recreated:-none})"
