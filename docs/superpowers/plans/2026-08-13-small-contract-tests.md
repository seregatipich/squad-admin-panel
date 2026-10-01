# Plan for restoring the targeted contracts

1. Add a `PlayerMarkBadge` test for the empty state, severity,
   input immutability, the count and the fallback badge.
2. Add a `TagInput` test for normalization, limits, removal and focus.
3. Add a test of the shared external-ban version key and the root export.
4. Strengthen the log-ingest cache test by checking the argument of both version reads.
5. For each group, temporarily weaken the production boundary, record the expected
   failure and restore the original code before committing.
6. Run the four relevant files, the web/shared-types/log-ingest package tests,
   the type check and Biome.
7. Review the diff, run the full local gate, the secret scan and the mechanical
   attestation of the branch; then publish it for sequential merging.
