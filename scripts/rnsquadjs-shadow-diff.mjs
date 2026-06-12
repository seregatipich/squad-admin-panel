#!/usr/bin/env node
// Usage: REDIS_URL=redis://127.0.0.1:6379 node scripts/rnsquadjs-shadow-diff.mjs <serverId> [sinceMs] [minEvents]
//   minEvents also reads from env MIN_EVENTS (positional arg wins); default 100.
// Prereq: build the plugin first — cd docker/rnsquadjs/plugins/panelBridge && npx tsc -p tsconfig.json
//
// Gate (exit 1 on any failure, 0 only when all pass):
//   - corrupt-data:      zero valid prod events while malformed records were skipped
//   - insufficient-data: prod event count below the minEvents floor
//   - extras-exceeded:   shadow has more than max(5, 1% of prod) unmatched extras
//   - parity-failed:     parity < 99% or a prod event type is missing in shadow
// Malformed stream records (no 'envelope' field or unparseable JSON) are skipped and counted.
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
const since = Date.now() - Number(sinceMsRaw ?? 24 * 3600 * 1000);
const minEvents = Number(minEventsRaw ?? process.env.MIN_EVENTS ?? 100);
if (!Number.isInteger(minEvents) || minEvents < 0) {
  console.error(`invalid minEvents: ${minEventsRaw ?? process.env.MIN_EVENTS}`);
  process.exit(2);
}
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

let badRecords = 0;
async function readStream(name) {
  const raw = await redis.xrange(name, String(since), '+');
  const events = [];
  for (const [, fields] of raw) {
    const idx = fields.indexOf('envelope');
    if (idx === -1) {
      badRecords += 1;
      continue;
    }
    try {
      const envelope = JSON.parse(fields[idx + 1]);
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
  if (prod.length === 0 && badRecords > 0) {
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
