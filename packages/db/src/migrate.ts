import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { appRoleFromEnv, provisionAppRole } from './app-role.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
// Validate before touching the database so a typo fails the deploy up front.
const appRole = appRoleFromEnv(process.env);

const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: './drizzle' });
console.log('migrations applied');
if (appRole) {
  await provisionAppRole(sql, appRole);
  console.log(`application role ${appRole.role} provisioned`);
}
await sql.end();
