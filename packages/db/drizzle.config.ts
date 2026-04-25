import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL must be set to generate / run migrations');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './dist/schema/index.js',
  out: './drizzle',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
