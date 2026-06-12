#!/usr/bin/env node
// Usage: REDIS_URL=redis://127.0.0.1:6379 node scripts/rnsquadjs-shadow-diff.mjs <serverId> [sinceMs]
// Prereq: build the plugin first — cd docker/rnsquadjs/plugins/panelBridge && npx tsc -p tsconfig.json
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

const [serverId, sinceMsRaw] = process.argv.slice(2);
if (!serverId) {
  console.error('usage: rnsquadjs-shadow-diff.mjs <serverId> [sinceMs]');
  process.exit(2);
}
const since = Date.now() - Number(sinceMsRaw ?? 24 * 3600 * 1000);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

async function readStream(name) {
  const raw = await redis.xrange(name, String(since), '+');
  return raw.map(([, fields]) => {
    const envelope = JSON.parse(fields[fields.indexOf('envelope') + 1]);
    return { type: envelope.type, ts: envelope.ts, payload: envelope.payload };
  });
}

// D4: only log-pipeline event types are owned by the sidecar; rcon.* stay with worker-rcon.
const SIDE_TYPES = new Set([
  'player.connected', 'player.disconnected', 'player.name_changed',
  'match.started', 'match.ended',
]);
const prod = (await readStream(`events:server:${serverId}`)).filter((e) => SIDE_TYPES.has(e.type));
const shadow = (await readStream(`events:server:${serverId}:shadow`)).filter((e) =>
  SIDE_TYPES.has(e.type),
);
const r = compareStreams(prod, shadow);
console.log(JSON.stringify({ serverId, prod: prod.length, shadow: shadow.length, ...r }, null, 2));
await redis.quit();
process.exit(r.parityPct >= 99 && r.missingTypes.length === 0 ? 0 : 1);
