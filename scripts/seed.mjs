// scripts/seed.mjs
/**
 * Seeds the database with a test tenant and a starter plan.
 * Run with: node scripts/seed.mjs
 *
 * Uses pg directly (not Drizzle) to keep it zero-build.
 * Reads DATABASE_URL from .env via a simple fs-based parser.
 */

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env manually (no dotenv dependency) ──────────────
function loadEnv() {
  try {
    const envPath = resolve(__dirname, '..', '.env');
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env not found — rely on environment variables
  }
}

loadEnv();

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://p5_admin:p5_secret@localhost:5432/p5_billing';

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL });

async function seed() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── 1. Seed a starter plan if plans table is empty ──────
    const planCheck = await client.query('SELECT id FROM plans LIMIT 1');
    let planId = null;

    if (planCheck.rows.length === 0) {
      const planResult = await client.query(
        `INSERT INTO plans (name, max_buckets, max_storage_bytes, max_monthly_ingress_bytes, max_monthly_egress_bytes, price_ucents_per_month)
         VALUES ('starter', 10, 107374182400, 10737418240, 10737418240, 0)
         ON CONFLICT (name) DO UPDATE SET name = 'starter'
         RETURNING id`,
      );
      planId = planResult.rows[0].id;
      console.log(`Seeded plan: starter  id: ${planId}`);
    } else {
      planId = planCheck.rows[0].id;
      console.log(`Plan already exists: ${planId}`);
    }

    // ── 2. Seed a test tenant ──────────────────────────────
    const tenantResult = await client.query(
      `INSERT INTO tenants (slug, display_name, email, status, plan_id, max_buckets, max_storage_bytes)
       VALUES ('acme', 'Acme Corp', 'admin@acme.io', 'active', $1, 10, 107374182400)
       ON CONFLICT (slug) DO UPDATE SET
         status = 'active',
         email = 'admin@acme.io',
         display_name = 'Acme Corp'
       RETURNING id, slug, email`,
      [planId],
    );

    const tenant = tenantResult.rows[0];
    console.log(`Seeded tenant: ${tenant.slug}  email: ${tenant.email}  id: ${tenant.id}`);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
