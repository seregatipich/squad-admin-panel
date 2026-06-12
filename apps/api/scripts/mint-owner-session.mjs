import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';

const STEAM_ID = 76561198999999003n;
const TTL_MS = 6 * 60 * 60 * 1000;

const raw = randomBytes(24).toString('base64url');
const token = `s_${uuidv7()}_${raw}`;
const tokenId = createHash('sha256').update(token).digest('base64url');
const now = new Date();
const expiresAt = new Date(now.getTime() + TTL_MS);

const sql = postgres(process.env.DATABASE_URL);

await sql`
  INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized, role_id)
  VALUES (${STEAM_ID}, ${'e2e-owner'}, ${'e2e-owner'}, (SELECT id FROM roles WHERE name = 'Owner'))
  ON CONFLICT (steam_id64) DO UPDATE SET role_id = (SELECT id FROM roles WHERE name = 'Owner')
`;

await sql`
  INSERT INTO sessions (id, steam_id64, expires_at, last_activity_at, ip, user_agent)
  VALUES (${tokenId}, ${STEAM_ID}, ${expiresAt}, ${now}, NULL, ${'e2e-test-runner'})
`;

await sql.end();
console.log(token);
