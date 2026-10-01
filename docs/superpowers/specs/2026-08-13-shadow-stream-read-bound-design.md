# Bounded reads of RNSquadJS shadow streams

Tracking issue: `breaking-squad/squad-admin-panel#282`.

## Goal

Do not let the manual RNSquadJS conformance check load an unbounded range of
Redis Streams into memory or pass off a partial comparison as a
success. Invalid parameters must be rejected before connecting to Redis.

## Root cause

In the earlier accumulating branch the check used a bounded `XRANGE`, but
when the semantic envelope validation was carried over independently into the current `dev`,
only the content check was ported. The current script again calls
`XRANGE` without `COUNT`, and converts `sinceMs` through `Number` without validation.

This is an operator tool, but it reads live streams. An erroneously large
interval or a corrupted setting can put unbounded load on the
process and on Redis precisely during release acceptance.

## Options considered

### 1. `COUNT = limit + 1` and fail-closed

Each stream is read with a single `XRANGE` whose record count is one more than the limit.
The presence of the extra record sets `inputLimitExceeded`; the comparison receives
at most `limit` elements, and the final gate becomes
`input-limit-exceeded`.

Pros: one request, bounded memory, no false success. Con:
the threshold is an operator setting. This is the chosen option.

### 2. Paged reads of the whole range

Bounds the memory of a single page, but does not bound the total time, CPU or
number of requests. A large input can still overload acceptance. Rejected.

### 3. `XCOUNT` before `XRANGE`

Gives an early estimate, but adds a request and creates a race: the stream may change
between the count and the read. Rejected.

## Contract

- `MAX_STREAM_RECORDS` defaults to `100000`.
- Only safe integers from `1` to `1000000` inclusive are allowed.
- `sinceMs` and `minEvents` are safe integers that are at least zero.
- A parameter error is printed to stderr and ends the process with code `2` before
  the Redis client is created.
- Both streams are read with `COUNT = MAX_STREAM_RECORDS + 1`.
- The first `MAX_STREAM_RECORDS` records of each stream enter the comparison.
- If at least one stream returned an extra record, the result contains
  `inputLimitExceeded: true`, `maxStreamRecords` and the gate
  `input-limit-exceeded`; the exit code is `1`.
- The limit takes priority over `corrupt-data`, `insufficient-data`,
  `extras-exceeded` and `parity-failed`: a partial input cannot be interpreted.
- The current envelope check, the list of sidecar-owned events and the conformance
  thresholds do not change.

## Verification

- exactly the limit number of records proceeds to the normal check;
- the limit plus one record yields `input-limit-exceeded` and does not raise the number of
  compared elements above the limit;
- a zero, negative, fractional, non-numeric and too large limit value
  yields code `2`;
- a negative, fractional and non-numeric time window yields code `2`;
- the existing seven scenarios keep passing;
- the relevant checks, Biome, the full local gate and the mechanical check of the
  working branch must be green.

## Out of scope

- carrying over the old test DB scaffolding or other commits of the accumulating branch;
- changing Redis retention, the envelope format or the comparison algorithm;
- automatically raising the threshold, or a successful result on a truncated
  sample.
