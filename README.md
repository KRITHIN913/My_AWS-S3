# Multi-Tenant S3 Billing & Metering Engine

[![Build](https://img.shields.io/github/actions/workflow/status/your-org/s3-billing-engine/ci.yml?style=flat-square)]()
[![License](https://img.shields.io/github/license/your-org/s3-billing-engine?color=2185d0&style=flat-square)](LICENSE)

Established in March 2026.

**S3-compatible usage tracking and billing made simple.**

A robust, fast, scalable backend system for tracking, metering, and invoicing multi-tenant object storage.

## Table of Contents

* [About](#about)
* [Features](#features)
* [Architecture](#architecture)
* [Get Started](#get-started)
* [SDK Integration](#sdk-integration)
* [Community](#community)
* [Author and Contributors](#author-and-contributors)
* [License](#license)

## About

The **Multi-Tenant S3 Billing & Metering Engine** is a robust, scalable backend system designed to sit between your tenants and your S3-compatible backend (e.g., MinIO, AWS S3). You can use it to build SaaS products that provide storage solutions while seamlessly tracking usage, enforcing quotas, and generating billing invoices.

It functions as a smart proxy Layer 7 router, ensuring every `PutObject`, `GetObject`, and `DeleteObject` operation is metered in real-time. Background processors automatically handle quota breaches and dispatch webhooks to internal systems or directly to your customers.

## Features

* **Self-hostable**: Fully containerized using Docker Compose.
* **Modern Stack**: Built with TypeScript, Fastify, Drizzle ORM, PostgreSQL, and Redis.
* **Real-time Quota Monitoring**: Fast Redis-backed atomic counters to prevent quota breaches instantly.
* **Scheduled Usage Aggregation**: Background jobs for daily and monthly storage snapshotting and usage aggregation.
* **Webhooks**: Reliable HTTP callbacks for outbound event dispatching (e.g., quota limits reached, new invoices).
* **Direct S3 Compatibility**: Intercepts and logs operations transparently, meaning you can plug in any AWS SDK without changing client code.
* **Robust Test Suite**: Extensive test suites written in Vitest proving precise implementation of S3 operations.

## Architecture

The engine is composed of several critical, loosely-coupled infrastructure elements:

* **PostgreSQL (Control Plane)**: The source of truth for tenants, buckets, quota settings, invoices, and webhook history.
* **Redis (Data Plane/Counters)**: Facilitates high-performance rate limiting and tracks real-time bytes read/written.
* **MinIO (Storage Node)**: The underlying S3-compatible block storage.
* **Fastify API Server**: The high-performance API that validates S3 requests, updates Redis counters, and proxies accepted traffic to MinIO.

## Get Started

You have a few ways to get started. The project relies strictly on Docker for infrastructure bootstrapping.

1. Clone the repository to your machine.
2. Spin up the supporting infrastructure (PostgreSQL, Redis, MinIO):
```bash
docker-compose up -d postgres redis minio
```
3. Install the API engine dependencies:
```bash
npm install
```
4. Push the Drizzle schema to the newly spun-up PostgreSQL database:
```bash
npm run db:push
```
5. Start the Fastify API engine:
```bash
npm run dev
```

## SDK Integration

Because the billing engine transparently handles standard S3 requests, you can use the official AWS SDK exactly as you normally would. Ensure you point the client at the Fastify server port (`3000`).

```typescript
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const client = new S3Client({
  endpoint: "http://localhost:3000", // Fastify API gateway
  region: "us-east-1",
  credentials: {
      accessKeyId: "TENANT_ACCESS_KEY",
      secretAccessKey: "TENANT_SECRET_KEY"
  }
});

await client.send(
  new PutObjectCommand({ 
    Bucket: "my-tenant-bucket", 
    Key: "hello-world.txt", 
    Body: "Hello from the Billing Engine!" 
  })
);
```

## Community

Join our community to get help, share feedback, and contribute.

* [Report an issue](https://github.com/your-org/multi-tenant-s3-billing-engine/issues)
* [Start a Discussion](https://github.com/your-org/multi-tenant-s3-billing-engine/discussions)

## Author and Contributors

Built securely for teams creating the next generation of SaaS infrastructure.

## License

This software is licensed under the [MIT License](LICENSE).