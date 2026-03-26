// src/lib/s3ProxyStream.ts

/**
 * S3 Proxy Stream Utilities
 *
 * Low-level building blocks for streaming object data between Fastify
 * and MinIO. This module has NO business logic — it handles the byte-level
 * plumbing only. Route handlers compose these utilities with billing and
 * quota logic from meteringService.
 *
 * Design:
 *   - Zero buffering. Data flows chunk-by-chunk through Transform streams.
 *   - ByteCounterTransform counts bytes as a side-effect without altering data.
 *   - pipeline() from stream/promises handles error propagation and cleanup.
 *   - MinIO putObject accepts a Readable + size. MinIO getObject returns a Readable.
 */

import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TransformCallback } from 'node:stream';
import type { FastifyReply } from 'fastify';
import type { Client } from 'minio';

// ─────────────────────────────────────────────────────────────
// ByteCounterTransform
// ─────────────────────────────────────────────────────────────

/**
 * A Transform stream that counts bytes as they pass through.
 * Does not alter the data — pure passthrough with a side-effect counter.
 *
 * Usage:
 *   const counter = new ByteCounterTransform();
 *   await pipeline(source, counter, destination);
 *   console.log(counter.bytesTransferred); // BigInt
 *
 * The counter uses BigInt to avoid precision loss on files larger than
 * Number.MAX_SAFE_INTEGER (~9 PiB — unlikely but correctness matters).
 */
export class ByteCounterTransform extends Transform {
  /** Total bytes that have passed through this transform. */
  public bytesTransferred: bigint = 0n;

  /**
   * Processes each chunk by adding its length to the counter and
   * forwarding it unchanged.
   *
   * @param chunk    - The incoming data chunk (Buffer in object mode off).
   * @param encoding - The encoding type (ignored for Buffer chunks).
   * @param callback - Signal completion and pass the chunk downstream.
   */
  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.bytesTransferred += BigInt(chunk.length);
    callback(null, chunk);
  }
}

// ─────────────────────────────────────────────────────────────
// streamPutToMinio
// ─────────────────────────────────────────────────────────────

/**
 * Pipes a source Readable stream through a ByteCounterTransform
 * into MinIO's putObject. Returns the byte count when the upload completes.
 *
 * CRITICAL: Does not buffer. The source stream is piped directly through
 * the counter into MinIO. Memory usage is O(chunk_size), not O(file_size).
 *
 * MinIO's putObject accepts a Readable stream with an optional size hint.
 * When contentLength is -1 (chunked transfer), MinIO buffers internally
 * to compute the content hash — this is a MinIO SDK limitation, not ours.
 *
 * @param minioClient   - Initialised MinIO Client instance.
 * @param physicalName  - MinIO bucket name (e.g. "acme--photos").
 * @param objectKey     - Object key within the bucket.
 * @param source        - The raw Node.js Readable stream from Fastify's request.raw.
 * @param contentLength - Value of Content-Length header, or -1 if absent.
 * @param contentType   - Value of Content-Type header.
 * @returns bytesUploaded as bigint — the actual bytes that flowed through the pipe.
 * @throws Re-throws any MinIO error — caller handles the HTTP response.
 */
export async function streamPutToMinio(
  minioClient: Client,
  physicalName: string,
  objectKey: string,
  source: Readable,
  contentLength: number,
  contentType: string,
): Promise<bigint> {
  const counter = new ByteCounterTransform();

  // Create a passthrough pipe: source → counter
  // We then hand the counter (which is also a Readable) to MinIO.
  const counted = source.pipe(counter);

  const size = contentLength >= 0 ? contentLength : undefined;
  const metaData = { 'Content-Type': contentType };

  await minioClient.putObject(
    physicalName,
    objectKey,
    counted,
    size,
    metaData,
  );

  return counter.bytesTransferred;
}

// ─────────────────────────────────────────────────────────────
// streamGetFromMinio
// ─────────────────────────────────────────────────────────────

/**
 * Streams an object from MinIO directly into the Fastify reply stream.
 * Counts bytes as they flow out. Returns the byte count when the stream ends.
 *
 * CRITICAL: Uses reply.raw (the raw Node.js ServerResponse) for piping.
 * reply.send() would cause Fastify to serialise the stream as JSON.
 *
 * Sets these response headers before streaming:
 *   - Content-Type (from MinIO stat)
 *   - Content-Length (from MinIO stat)
 *   - ETag (from MinIO stat)
 *   - Last-Modified (from MinIO stat)
 *   - x-amz-request-id (from requestId parameter)
 *
 * @param minioClient  - Initialised MinIO Client instance.
 * @param physicalName - MinIO bucket name.
 * @param objectKey    - Object key within the bucket.
 * @param reply        - Fastify reply object (used for reply.raw access and headers).
 * @param requestId    - Request ID for the x-amz-request-id header.
 * @returns bytesDownloaded as bigint.
 * @throws On MinIO error — caller distinguishes 404 vs 500.
 */
export async function streamGetFromMinio(
  minioClient: Client,
  physicalName: string,
  objectKey: string,
  reply: FastifyReply,
  requestId: string,
): Promise<bigint> {
  // Stat the object first to get metadata for response headers
  const stat = await minioClient.statObject(physicalName, objectKey);

  // Set response headers before streaming
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': stat.metaData?.['content-type'] ?? 'application/octet-stream',
    'Content-Length': stat.size.toString(),
    'ETag': stat.etag,
    'Last-Modified': stat.lastModified.toUTCString(),
    'x-amz-request-id': requestId,
  });

  // Get the object stream from MinIO
  const objectStream = await minioClient.getObject(physicalName, objectKey);
  const counter = new ByteCounterTransform();

  // Pipeline: MinIO stream → counter → HTTP response
  await pipeline(objectStream, counter, raw);

  // Tell Fastify we've handled the response manually
  reply.hijack();

  return counter.bytesTransferred;
}
