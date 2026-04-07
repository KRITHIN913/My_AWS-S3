// drizzle.config.ts
import type { Config } from 'drizzle-kit';

export default {
  schema:    './src/drizzle/schema.ts',
  out:       './drizzle/migrations',
  dialect:   'postgresql',
  dbCredentials: { url: process.env['DATABASE_URL']! },
  verbose:   true,
  strict:    true,
} satisfies Config;
