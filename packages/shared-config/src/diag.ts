/**
 * Redis Stream key for the panel-wide diagnostic event queue.
 *
 * Producers (api, workers, bridge journald exporter) `XADD` to this stream
 * via `@squad/diag`'s `createDiag().emit()`. The consumer
 * `worker-diag-flush` reads with `XREADGROUP` and batches inserts into
 * the `diagnostic_events` Postgres partitioned table.
 *
 * Kept here so consumers that only need the key (worker-diag-flush, the
 * wipe endpoint) don't have to take a runtime dep on `@squad/diag`.
 */
export const DIAG_STREAM_KEY = 'diag:queue';

/**
 * Safety-net cap on the Redis Stream length. `XADD MAXLEN ~ 100000` keeps
 * Redis memory bounded if the flush worker stalls — once exceeded, oldest
 * entries are evicted in O(1). Each entry is ~300 bytes, so the cap is
 * roughly 30 MiB.
 */
export const DIAG_STREAM_MAXLEN = 100_000;
