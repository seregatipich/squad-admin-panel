# Operations script and audit chain checks — design

## Goal

Restore to the current `dev` a self-contained safety net for the scripts that
install, deploy, rebuild and remove the panel, and for the out-of-band audit
chain verification. The old branch is not carried over as a whole; only the
re-verified contracts of the current files are.

## Chosen boundary

### Operations Bash scripts

The tests run real copies of the current scripts but replace, via `PATH`, every
command that could change the host: `docker`, `systemctl`, `install`, `rm` and
others. The stand-ins write their exact arguments to a log inside a temporary
directory. This verifies ordering, quoting, exit codes and stopping after an
error, without access to the real Docker, systemd or system paths.

Contracts under test:

- all scripts have valid Bash syntax and strict mode;
- `bootstrap` and `install-host-bridge` refuse before the first mutation when
  preflight fails;
- an error in a child installer is returned to the calling `bootstrap`;
- `deploy` requires an env file, preserves the Compose arguments, and does not
  declare success if the API does not become healthy or the HTTP probe fails;
- `rebuild` and `uninstall` change nothing without an exact confirmation, and an
  error in a mandatory step prevents moving on to the next ones;
- `verify-bridge` exchanges real length-prefixed JSON frames over a temporary
  Unix socket and stops the chain at the first missing response.

### Audit chain verification

The integration test creates a separate temporary database, applies the current
migrations, inserts rows through the real `audit_log` trigger, runs the real
`scripts/verify-audit-chain.ts` as a separate process, and then corrupts
`row_hash` or `prev_hash` only after temporarily disabling the append-only
trigger. It checks the exact identifier of the first corrupted row and the
distinction between result codes: `0` — the chain is intact, `1` — corruption
proven, `2` — configuration or a dependency is unavailable.

## Current defect found

After the wait loop is exhausted, `scripts/deploy-stand.sh` does not check the
final `status`, suppresses the `curl` error with `|| true`, and always prints
`Deploy complete`. The red tests must first reproduce both branches.
Minimal fix: an explicit failure after the API timeout and a mandatory HTTP
success for the local probe through Caddy; the order build → up → API healthy →
HTTP probe → status stays the same.

## Integration

The root `pnpm test:scripts` runs the operations script tests, shadow-diff and
the audit chain tests in sequence. CI already applies migrations before this step;
this ordering is additionally pinned by a static check.
The audit suite tolerates a missing database only outside CI, but when
`DATABASE_URL` is provided it always runs and cannot silently skip the tests.

## Rejected options

- Merge `chore/reattestation-coverage-gaps`: the branch is hundreds of commits
  behind and mixes in unrelated runtime changes.
- Run the real host commands: unacceptable for local development and CI.
- Stop at `bash -n`: syntax does not prove ordering, fail-closed behavior or
  correctness of the framed protocol.
- Mock `verify-audit-chain` itself: that would not exercise the migration triggers
  and the canonical hash form.

## Risks and limitations

- The test stand-ins must cover every potential host mutation; any
  extension of a script must fail on an unknown command rather than reach
  the host.
- Temporary databases get unique names and are dropped in teardown; the test never
  modifies the source database.
- The check does not replace manual acceptance of a real production deploy, but it forbids
  a false programmatic success of its control script.
