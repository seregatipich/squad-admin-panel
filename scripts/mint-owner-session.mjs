import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { v7 as uuidv7 } from 'uuid';

const STEAM_ID = 76561198999999003n;
const TTL_MS = 6 * 60 * 60 * 1000;

const raw = randomBytes(24).toString('base64url');
const token = `s_${uuidv7()}_${raw}`;
const tokenId = createHash('sha256').update(token).digest('base64url');
const now = new Date();
const expiresAt = new Date(now.getTime() + TTL_MS);

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const { rows } = await c.query(
  `INSERT INTO players (steam_id64, role_id) VALUES ($1, (SELECT id FROM roles WHERE name='Owner')) ON CONFLICT (steam_id64) DO UPDATE SET role_id=(SELECT id FROM roles WHERE name='Owner') RETURNING id`,
  [STEAM_ID],
);
const playerId = rows[0].id;

await c.query(
  `INSERT INTO sessions (id, player_id, expires_at, last_activity_at, ip, user_agent) VALUES ($1, $2, $3, $4, NULL, $5)`,
  [tokenId, playerId, expiresAt, now, 'e2e-test-runner'],
);

await c.end();
console.log(token);
