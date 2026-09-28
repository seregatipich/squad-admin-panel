# Restic backup image (INFRA-8).
# Extends djmaze/resticker (mazzolino/restic) with the CLI tools its
# PRE_COMMANDS need: pg_dump/pg_restore (postgresql16-client) produce and
# restore the logical Postgres dump, and redis-cli (redis) fetches the Redis
# RDB. See docker/compose.yml `backup` service and scripts/restore.sh.
#
# The base is pinned by digest, not by the mutable `latest` tag: this image
# receives POSTGRES_PASSWORD and RESTIC_PASSWORD and reads the full database
# dump, so an upstream push must never reach it unreviewed. The digest is the
# `latest` build of 2026-07-07 (Alpine 3.22.5, so the packages below resolve
# from the main repo). Bump it deliberately; scripts/test-dependency-pins.sh
# fails CI on an unpinned base.
FROM mazzolino/restic@sha256:84a18b739c15216b07dcb9e14985437d49b7a3a68ef8ce48c1323b9f59bf794e
RUN apk add --no-cache postgresql16-client redis
