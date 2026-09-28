# Restic backup image (INFRA-8).
# Extends djmaze/resticker (mazzolino/restic) with the CLI tools its
# PRE_COMMANDS need: pg_dump/pg_restore (postgresql16-client) produce and
# restore the logical Postgres dump, and redis-cli (redis) fetches the Redis
# RDB. The base image is Alpine 3.22, so these packages resolve from the main
# repo. See docker/compose.yml `backup` service and scripts/restore.sh.
FROM mazzolino/restic:latest@sha256:84a18b739c15216b07dcb9e14985437d49b7a3a68ef8ce48c1323b9f59bf794e
RUN apk add --no-cache postgresql16-client redis
