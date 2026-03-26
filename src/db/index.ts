// src/db/index.ts

/**
 * Database connection module.
 *
 * Sets up a `pg` Pool and wraps it in Drizzle ORM.
 * Exports the typed `db` instance and its type alias `DrizzleDb`
 * so that service modules can accept the DB as a parameter
 * without depending on a global singleton.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../drizzle/schema.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
});

/**
 * Drizzle ORM database instance backed by the connection pool.
 * This is the primary entry-point for all SQL operations.
 */
export const db = drizzle(pool, { schema });

/** The Drizzle database type — use this for function signatures. */
export type DrizzleDb = typeof db;

/** Expose the raw pool for advisory-lock SQL and test tear-down. */
export { pool };
