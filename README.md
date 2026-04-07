# Multi-Tenant S3 Billing & Metering Engine

A production-grade, multi-tenant S3-compatible storage billing system with real-time metering,
quota enforcement, and a self-service dashboard.

## Architecture

```
┌────────────────────┐       ┌────────────────────┐
│   Next.js 14       │ HTTP  │   Fastify Backend   │
│   Frontend :3001   │──────▶│   :3000              │
└────────────────────┘       │   ├── /auth/login    │
                             │   ├── /portal/*      │
                             │   ├── /billing/*     │
                             │   ├── /admin/*       │
                             │   └── S3 proxy       │
                             └────────┬─────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                  │
              ┌─────▼─────┐   ┌──────▼──────┐   ┌──────▼──────┐
              │ PostgreSQL │   │    Redis     │   │    MinIO     │
              │   :5432    │   │    :6379     │   │   :9000      │
              └────────────┘   └─────────────┘   └─────────────┘
```

---

## Running the full stack

### Prerequisites
- Docker Desktop
- Node.js 20+

### 1. Start backend services

```bash
cd "Billing System"
cp .env.example .env
docker compose up -d          # starts postgres, redis, minio
npm install
npm run db:push               # drizzle-kit push schema
npm run dev                   # fastify on :3000
```

### 2. Seed a test tenant (run once)

```bash
node scripts/seed.mjs
```

This creates:
- **Tenant:** `acme` — email: `admin@acme.io`, status: `active`
- **Plan:** `starter` — 10 buckets, 100 GiB storage

### 3. Start frontend

```bash
cd frontend

# Option A: connect to real backend
echo "NEXT_PUBLIC_API_URL=http://localhost:3000" > .env.local
echo "NEXT_PUBLIC_USE_MOCK=false" >> .env.local

# Option B: use mock data (no backend needed)
cp .env.local.mock .env.local

npm install
npm run dev                   # next.js on :3001
```

### 4. Login

Open [http://localhost:3001](http://localhost:3001)

| Field    | Value            |
| -------- | ---------------- |
| Email    | `admin@acme.io`  |
| Password | anything         |

> **Note:** Password validation is a stub (Phase 7). Any non-empty password
> succeeds if the tenant email exists and is `active`.

---

## Environment Variables

### Backend (`.env`)

| Variable              | Required | Default                  | Description                     |
| --------------------- | -------- | ------------------------ | ------------------------------- |
| `DATABASE_URL`        | ✅        | —                        | PostgreSQL connection string    |
| `REDIS_URL`           | ✅        | —                        | Redis connection string         |
| `MINIO_ROOT_USER`     | ✅        | —                        | MinIO access key                |
| `MINIO_ROOT_PASSWORD` | ✅        | —                        | MinIO secret key                |
| `MINIO_ENDPOINT`      |          | `localhost`              | MinIO hostname                  |
| `MINIO_PORT`          |          | `9000`                   | MinIO port                      |
| `MINIO_USE_SSL`       |          | `false`                  | Enable TLS for MinIO            |
| `ADMIN_JWT_SECRET`    |          | —                        | HS256 secret for admin JWT auth |
| `CORS_ORIGIN`         |          | `http://localhost:3001`  | Allowed CORS origin             |
| `PORT`                |          | `3000`                   | Fastify listen port             |

### Frontend (`.env.local`)

| Variable               | Default                  | Description                       |
| ---------------------- | ------------------------ | --------------------------------- |
| `NEXT_PUBLIC_API_URL`  | `http://localhost:3000`  | Backend API base URL              |
| `NEXT_PUBLIC_USE_MOCK` | `true`                   | Use mock data instead of real API |

---

## API Routes

### Auth (unauthenticated)
- `POST /auth/login` — Returns a one-time API key for the session

### Portal (tenant API key required)
- `GET /portal/profile` — Tenant profile
- `PATCH /portal/profile` — Update profile
- `GET /portal/keys` — List API keys
- `POST /portal/keys` — Generate new API key
- `DELETE /portal/keys/:keyId` — Revoke API key
- `GET /portal/buckets` — List buckets
- `DELETE /portal/buckets/:name` — Soft-delete bucket
- `GET /portal/usage/current` — Live quota usage
- `GET /portal/usage/history` — Historical usage
- `GET /portal/alerts` — Quota breach alerts

### Billing (tenant API key required)
- `GET /billing/invoices` — List invoices
- `GET /billing/invoices/:invoiceId` — Get single invoice
- `GET /billing/usage` — Aggregate usage metrics

### Admin (JWT required)
- `GET /admin/tenants` — List all tenants
- `POST /admin/tenants` — Create tenant
- `PATCH /admin/tenants/:id` — Update tenant
- `POST /admin/tenants/:id/suspend` — Suspend tenant
- `POST /admin/tenants/:id/unsuspend` — Reactivate tenant
- `DELETE /admin/tenants/:id` — Soft-delete tenant
- `POST /admin/tenants/:id/plan` — Assign plan
- `PATCH /admin/tenants/:id/quota` — Override quotas
- `GET /admin/plans` — List plans
- `POST /admin/plans` — Create plan
- `PATCH /admin/plans/:id` — Update plan
- `DELETE /admin/plans/:id` — Deactivate plan
- `GET /admin/invoices` — List all invoices
- `POST /admin/invoices/:id/finalise` — Finalise invoice
- `POST /admin/invoices/:id/void` — Void invoice
- `GET /admin/system/health` — Infrastructure health check
- `GET /admin/system/audit-log` — Audit trail

---

## Background Jobs

| Job                | Interval   | Purpose                                                |
| ------------------ | ---------- | ------------------------------------------------------ |
| Quota Breach Watch | 5 min      | Compares Redis counters to limits, inserts breach events |
| Storage Snapshot   | 1 hour     | Queries MinIO for true bucket sizes, recalibrates Redis |
| Usage Aggregator   | Monthly    | Rolls up usage_metrics into invoices on the 1st        |
| Webhook Dispatcher | 30 sec     | Polls pending webhooks, delivers with HMAC + retry      |

---

## License

Apache 2.0