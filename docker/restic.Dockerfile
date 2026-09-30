# Restic backup image (INFRA-8).
# Extends djmaze/resticker (mazzolino/restic) with the CLI tools its
# PRE_COMMANDS need: pg_dump/pg_restore (postgresql16-client) produce and
# restore the logical Postgres dump, and redis-cli (redis) fetches the Redis
# RDB. The base image (release 1.8.2, pinned by digest — it sees the database
# password and every dump) is Alpine 3.22, so these packages resolve from the
# main repo. See the `backup` service of docker/compose.yml and
# docker/compose.stand.yml, and scripts/restore.sh.
FROM mazzolino/restic:1.8.2@sha256:685293a0bc77eb054b74b207561e7d2eda6cfc910984c5a93db8f253055118e2
# panel.preserve=true keeps docker_prune (`docker system prune -a --filter
# label!=panel.preserve=true`) from deleting this image while it is unused.
LABEL panel.preserve=true
RUN apk add --no-cache postgresql16-client redis
