#!/usr/bin/env node
// Usage: REDIS_URL=redis://127.0.0.1:6379 node scripts/rnsquadjs-shadow-diff.mjs <serverId> [sinceMs] [minEvents]
//   minEvents also reads from env MIN_EVENTS (positional arg wins); default 100.
//   MAX_STREAM_RECORDS bounds each XRANGE read; default 100000, hard maximum 1000000.
// Prereq: build the plugin first — cd docker/rnsquadjs/plugins/panelBridge && npx tsc -p tsconfig.json
//
// Gate (exit 1 on any failure, 0 only when all pass):
//   - input-limit-exceeded: either stream contains more than MAX_STREAM_RECORDS entries
//   - corrupt-data:      any malformed or semantically invalid stream record
//   - insufficient-data: prod event count below the minEvents floor
//   - extras-exceeded:   shadow has more than max(5, 1% of prod) unmatched extras
//   - parity-failed:     parity < 99% or a prod event type is missing in shadow
// Malformed stream records (missing/invalid envelope fields or unparseable JSON) are skipped and
// counted. Any skipped record fails the gate so a corrupt stream cannot produce a false pass.
//
// ioredis is resolved from the plugin's node_modules via createRequire — no root dependency needed.
// Run from anywhere in the repo; compiled output is read from docker/rnsquadjs/plugins/panelBridge/dist/.
import { createRequire } from 'node:module';
import { compareStreams } from '../docker/rnsquadjs/plugins/panelBridge/dist/shadowDiff.js';

// Resolve ioredis from plugin's own node_modules regardless of CWD.
const require = createRequire(
  new URL('../docker/rnsquadjs/plugins/panelBridge/package.json', import.meta.url),
);
const Redis = require('ioredis');

const [serverId, sinceMsRaw, minEventsRaw] = process.argv.slice(2);
if (!serverId) {
  console.error('usage: rnsquadjs-shadow-diff.mjs <serverId> [sinceMs] [minEvents]');
  process.exit(2);
}
const sinceMs = Number(sinceMsRaw ?? 24 * 3600 * 1000);
if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) {
  console.error(`invalid sinceMs: ${sinceMsRaw}`);
  process.exit(2);
}
const minEvents = Number(minEventsRaw ?? process.env.MIN_EVENTS ?? 100);
if (!Number.isSafeInteger(minEvents) || minEvents < 0) {
  console.error(`invalid minEvents: ${minEventsRaw ?? process.env.MIN_EVENTS}`);
  process.exit(2);
}
const maxStreamRecords = Number(process.env.MAX_STREAM_RECORDS ?? 100_000);
if (
  !Number.isSafeInteger(maxStreamRecords) ||
  maxStreamRecords < 1 ||
  maxStreamRecords > 1_000_000
) {
  console.error(`invalid MAX_STREAM_RECORDS: ${process.env.MAX_STREAM_RECORDS}`);
  process.exit(2);
}
const since = Math.max(0, Date.now() - sinceMs);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isValidEnvelope(value, expectedServerId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!isUuid(value.event_id)) return false;
  if (!Number.isInteger(value.version) || value.version < 1) return false;
  if (typeof value.type !== 'string' || value.type.trim().length === 0) return false;
  if (value.server_id !== expectedServerId) return false;
  if (typeof value.ts !== 'string' || Number.isNaN(Date.parse(value.ts))) return false;
  if (
    value.actor !== null &&
    (typeof value.actor !== 'object' ||
      Array.isArray(value.actor) ||
      !['user', 'system', 'external'].includes(value.actor.kind) ||
      (value.actor.id !== null && typeof value.actor.id !== 'string'))
  ) {
    return false;
  }
  if (value.correlation_id !== null && !isUuid(value.correlation_id)) return false;
  return Object.hasOwn(value, 'payload');
}

let badRecords = 0;
let inputLimitExceeded = false;
async function readStream(name) {
  const raw = await redis.xrange(name, String(since), '+', 'COUNT', maxStreamRecords + 1);
  if (raw.length > maxStreamRecords) inputLimitExceeded = true;
  const events = [];
  for (const [, fields] of raw.slice(0, maxStreamRecords)) {
    const idx = fields.indexOf('envelope');
    if (idx === -1) {
      badRecords += 1;
      continue;
    }
    try {
      const envelope = JSON.parse(fields[idx + 1]);
      if (!isValidEnvelope(envelope, serverId)) {
        badRecords += 1;
        continue;
      }
      events.push({ type: envelope.type, ts: envelope.ts, payload: envelope.payload });
    } catch {
      badRecords += 1;
    }
  }
  return events;
}

// D4: only log-pipeline event types are owned by the sidecar; rcon.* stay with worker-rcon.
const SIDE_TYPES = new Set([
  'player.connected',
  'player.disconnected',
  'player.name_changed',
  'match.started',
  'match.ended',
]);

let exitCode = 1;
try {
  const prod = (await readStream(`events:server:${serverId}`)).filter((e) =>
    SIDE_TYPES.has(e.type),
  );
  const shadow = (await readStream(`events:server:${serverId}:shadow`)).filter((e) =>
    SIDE_TYPES.has(e.type),
  );
  const r = compareStreams(prod, shadow);
  const extraAllowed = Math.max(5, prod.length * 0.01);

  let gate = 'pass';
  if (inputLimitExceeded) {
    gate = 'input-limit-exceeded';
  } else if (badRecords > 0) {
    gate = 'corrupt-data';
  } else if (prod.length < minEvents) {
    gate = 'insufficient-data';
  } else if (r.extraInShadow.length > extraAllowed) {
    gate = 'extras-exceeded';
  } else if (r.parityPct < 99 || r.missingTypes.length > 0) {
    gate = 'parity-failed';
  }
  const verdict = gate === 'pass' ? 'pass' : 'fail';
  exitCode = gate === 'pass' ? 0 : 1;

  console.log(
    JSON.stringify(
      {
        serverId,
        minEvents,
        maxStreamRecords,
        inputLimitExceeded,
        prod: prod.length,
        shadow: shadow.length,
        badRecords,
        extraAllowed,
        gate,
        verdict,
        ...r,
      },
      null,
      2,
    ),
  );
  if (badRecords > 0) {
    console.error(`warning: skipped ${badRecords} malformed stream record(s)`);
  }
} finally {
  await redis.quit();
}

process.exit(exitCode);
