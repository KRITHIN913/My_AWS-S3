// src/lib/s3ProxyStream.ts



import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TransformCallback } from 'node:stream';
import type { FastifyReply } from 'fastify';
import type { Client } from 'minio';

// ─────────────────────────────────────────────────────────────
// ByteCounterTransform
// ─────────────────────────────────────────────────────────────


export class ByteCounterTransform extends Transform {
  /** Total bytes that have passed through this transform. */
  public bytesTransferred: bigint = 0n;

  
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
