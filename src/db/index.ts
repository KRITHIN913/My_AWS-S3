// src/db/index.ts

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../drizzle/schema.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
});


export const db = drizzle(pool, { schema });


export type DrizzleDb = typeof db;


export { pool };
