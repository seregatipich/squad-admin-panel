# Completion evidence and parallel-wave handoff

Details behind the "Definition of done" and "Completion verification" rules in [`CLAUDE.md`](../../CLAUDE.md). The mechanical checks are implemented by `scripts/verify-done.sh` (see [agent-harness.md](agent-harness.md)).

## GitHub issue completion evidence (issue-originated work only)

GitHub issue comments are the permanent review record for issue work; chat summaries, terminal output and CI status alone do not satisfy it. After `bash scripts/verify-done.sh --wait` passes, post **one** comment on the originating issue with the heading **`Completion evidence — 100% verified`** using `gh issue comment <number> --repo <owner/repo> ...`; the URL `gh` prints is the proof it was published. Keep it short and link instead of restating — five parts:

1. **Requirements** — a checklist mapping each requirement or acceptance criterion to the implementation file and the test that proves it.
2. **Tests** — the exact commands and their results with counts; for a bug fix, the regression test's red-before / green-after evidence.
3. **Runtime check** — the scenario exercised, the tool used, and an excerpt of the observed result (or `Not applicable — <why the change is not observable at runtime>`).
4. **Delivery** — work branch, delivered commit(s), current `dev` SHA, the `deploy` run URL and the `master` `ci` run URL, and `verify-done.sh --wait` passing.
5. **Limitations** — must say `None` for a 100% claim. If any required check or acceptance criterion was skipped, unavailable or failed, the issue is not 100% complete: post a progress/blocker comment instead and keep it open.

Never expose secrets, credentials or private user data in the comment. If code or CI changes after the comment is published, post a superseding comment before closing the issue. If GitHub commenting is unavailable, the task stays in progress and the access failure is reported as a blocker.

## Parallel-wave handoff (feature-branch terminal state)

When many tasks run in parallel (one work branch each) and an **orchestrator integrates them serially**, a task agent's terminal state is a *pushed feature branch*, not a dev merge — so the default `scripts/verify-done.sh` (which requires `dev == origin/dev`, a green stand deploy, and a green `ci` run on the promoted tip) does **not** apply. For that flow, **done = implemented + tested + committed + pushed feature branch**, verified with:

```bash
bash scripts/verify-done.sh --feature      # clean tree, on a work branch, pushed, branched off dev
```

The judgment angles of "Completion verification" in `CLAUDE.md` (requirements walked, tests actually run and load-bearing, diff self-review, docs) still apply in full. The orchestrator then merges the branch into `dev`, promotes the tip, and runs the default `scripts/verify-done.sh --wait`.

Every parallel task agent must also post a **`Feature-branch handoff evidence — not yet 100% complete`** comment on its issue before handoff. That comment must include the branch and commit SHA, requirement coverage, exact test and quality-gate results, runtime verification evidence, verification provenance, and every skip or limitation. It must explicitly state that final completion is pending merge to `dev`, the stand deploy, the `master` `ci` run, and the integrating agent's completion verification. The task agent must return the published comment URL to the orchestrator. After integration, the orchestrator is responsible for posting and verifying the final **`Completion evidence — 100% verified`** comment described above; a handoff comment can never substitute for it.
