import { Readable } from "node:stream"
import { createHash } from "node:crypto"
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import type { DriveStorageConfig } from "./cloud-drive-config.js"

export function driveStorageIdentity(config: DriveStorageConfig) {
  return createHash("sha256").update(JSON.stringify([config.endpoint, config.bucket, config.prefix])).digest("hex")
}

/** Portable Node SDK. Server credentials are never handed to a browser or agent. */
export function createDriveStorage(config: DriveStorageConfig) {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
    },
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  })
  return {
    identity: driveStorageIdentity(config),
    async put(key: string, bytes: Buffer) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket, Key: key, Body: bytes,
        ContentLength: bytes.length, ContentType: "application/octet-stream",
      }), { abortSignal: AbortSignal.timeout(30_000) })
    },
    async get(key: string) {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(30_000),
      })
      if (!(response.Body instanceof Readable)) throw new Error("Drive object body is missing")
      return response.Body
    },
    async delete(key: string) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(30_000),
      })
    },
    close() { client.destroy() },
  }
}
export type DriveStorage = ReturnType<typeof createDriveStorage>
