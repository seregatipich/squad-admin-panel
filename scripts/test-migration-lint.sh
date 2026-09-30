#!/usr/bin/env bash
# test-migration-lint.sh — fail when a Drizzle migration breaks one of the two
# rules in docs/operations/migrations.md ("Writing a migration"):
#
# 1. No explicit transaction control (#1068). drizzle-orm's migrate() runs all
#    pending migrations inside one transaction; a top-level `BEGIN;`/`COMMIT;`
#    commits it early and leaves every later migration in autocommit, so a
#    failure half-way leaves a partially applied schema with no journal row.
#    Migrations 0008–0020 predate the rule; applied files are never edited,
#    so they are grandfathered by name.
# 2. CHECK constraints on the large partitioned tables are added `NOT VALID`
#    (#1330). A plain `ADD CONSTRAINT … CHECK` validates every partition under
#    an ACCESS EXCLUSIVE lock held until the migration transaction commits;
#    `NOT VALID` plus a separate `VALIDATE CONSTRAINT` (SHARE UPDATE EXCLUSIVE)
#    does not block writes. Migrations up to 0118 are grandfathered.
#
# The script first proves each rule fires on a known-bad fixture, then scans
# packages/db/drizzle. Exit 0 = clean; exit 1 = a violation (or a rule that no
# longer fires).
set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)

TRANSACTION_GRANDFATHERED=(
  0008_steam_only_auth.sql
  0009_panel_rbac.sql
  0010_drop_servers_org_id.sql
  0011_servers_is_canary.sql
  0012_host_manage_permission.sql
  0014_role_access_flags_and_squad_perms.sql
  0015_reseed_roles_squad.sql
  0020_uuid_player_id.sql
)
LAST_UNCHECKED_CONSTRAINT_MIGRATION=118
LARGE_PARTITIONED_TABLES='events|chat_messages|combat_events|diagnostic_events|bonus_transactions|player_sessions'

# Prints one line per violation in the migrations under "$1".
lint_migrations() {
  local dir=$1 file name number
  for file in "$dir"/*.sql; do
    [[ -e "$file" ]] || continue
    name=$(basename "$file")
    number=$((10#${name%%_*}))

    if [[ ! " ${TRANSACTION_GRANDFATHERED[*]} " == *" $name "* ]]; then
      grep -niE '^[[:space:]]*(BEGIN|COMMIT|ROLLBACK|START[[:space:]]+TRANSACTION|END)[[:space:]]*(TRANSACTION|WORK)?[[:space:]]*;' "$file" |
        grep -viE '^[0-9]+:[[:space:]]*END[[:space:]]*;' |
        sed "s|^|$name:transaction control: |"
    fi

    if ((number > LAST_UNCHECKED_CONSTRAINT_MIGRATION)); then
      # One statement per record: join lines, split on ';'.
      tr '\n' ' ' <"$file" | tr ';' '\n' |
        grep -iE "ALTER[[:space:]]+TABLE[[:space:]]+(ONLY[[:space:]]+)?(IF[[:space:]]+EXISTS[[:space:]]+)?(public\.)?($LARGE_PARTITIONED_TABLES)[[:space:]].*ADD[[:space:]]+CONSTRAINT[[:space:]].*CHECK" |
        grep -viE 'NOT[[:space:]]+VALID' |
        sed -E "s/[[:space:]]+/ /g; s|^|$name:CHECK without NOT VALID: |"
    fi
  done
}

fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
cat >"$fixture/0500_bad_transaction.sql" <<'SQL'
BEGIN;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS lint_probe text;
COMMIT;
SQL
cat >"$fixture/0501_bad_check.sql" <<'SQL'
ALTER TABLE chat_messages
  ADD CONSTRAINT lint_probe_chk CHECK (source <> '');
SQL
cat >"$fixture/0502_good.sql" <<'SQL'
CREATE OR REPLACE FUNCTION lint_probe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER TABLE chat_messages
  ADD CONSTRAINT lint_probe_chk CHECK (source <> '') NOT VALID;
--> statement-breakpoint
ALTER TABLE chat_messages VALIDATE CONSTRAINT lint_probe_chk;
SQL

self_test=$(lint_migrations "$fixture")
expected_hits=(
  '0500_bad_transaction.sql:transaction control: 1:BEGIN;'
  '0500_bad_transaction.sql:transaction control: 3:COMMIT;'
  '0501_bad_check.sql:CHECK without NOT VALID:'
)
for hit in "${expected_hits[@]}"; do
  if [[ "$self_test" != *"$hit"* ]]; then
    echo "FAIL: migration lint self-test did not report: $hit" >&2
    echo "$self_test" >&2
    exit 1
  fi
done
if [[ "$self_test" == *0502_good.sql* ]]; then
  echo "FAIL: migration lint self-test flagged a valid migration:" >&2
  echo "$self_test" >&2
  exit 1
fi

violations=$(lint_migrations "$repo_root/packages/db/drizzle")
if [[ -n "$violations" ]]; then
  echo "FAIL: migration lint (see docs/operations/migrations.md, \"Writing a migration\"):" >&2
  echo "$violations" >&2
  exit 1
fi
echo "ok: migrations use no explicit transaction control and add large-table CHECKs NOT VALID"
