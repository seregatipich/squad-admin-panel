# Targeted contracts for marks, tags and the external-ban cache

## Context

An audit of the accumulating branch found four small checks that are missing from the
current `dev`. The components under test and the shared Redis contract are still
in use, so losing these tests leaves regressions unnoticed.
The source branch cannot be merged as a whole: it diverged from `dev` long ago and contains
unrelated working changes.

## Decision

Carry over only the behavioral checks, adapting them to the current sources:

- `PlayerMarkBadge` renders nothing for an empty set, picks the most severe mark,
  does not reorder the caller's array, and shows the count correctly;
- `TagInput` normalizes input, does not add empty/duplicate/excess tags,
  supports removal with the mouse and the Backspace key, and moves focus into the field;
- `@squad/shared-types` pins the exact name of the cache version key and exports
  it from the package root;
- the log-ingest cache reads exactly the shared key on every version check.

Production code is not changed in this task unless the relevant tests reproduce
a real defect. The tests join the existing package Vitest suites, so
no separate command or new CI step is needed.

## Evidence for the red phase

Since the current code already implements the expected behavior, after adding
the tests each new group is checked by a controlled temporary weakening of
the corresponding boundary. We observe the expected failure, restore the original code
and confirm the green result. The temporary weakenings are not part of the commits.

## Safety and boundaries

- the tests use no network, Docker, PostgreSQL, Redis or system commands;
- input arrays are checked for hidden mutation;
- the shared key is checked both at the contract owner and at the consumer;
- the mark badges here are the panel's own service badges, not the game
  icons of public statistics; the task does not add third-party game assets.

## Acceptance criterion

The three new files and the strengthened existing test pass the relevant package
suites, type checks, formatting and the full project gate. The diff against `dev` contains
only tests and this documentation.
