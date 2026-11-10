import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";
import type { Config } from "../config/schema.js";
import type { BlobStore } from "./store.js";

type S3Config = Extract<Config["storage"], { kind: "s3" }>;

/** S3 / MinIO: multipart upload (durable when it resolves), ranged GETs. */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      region: cfg.region,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async put(key: string, parts: AsyncIterable<Uint8Array>): Promise<void> {
    await new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: Readable.from(parts) },
    }).done();
  }

  async *getRange(key: string, start: number, endExclusive: number): AsyncIterable<Uint8Array> {
    if (endExclusive <= start) return;
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=${start}-${endExclusive - 1}`,
      }),
    );
    yield* res.Body as unknown as AsyncIterable<Uint8Array>;
  }

  async size(key: string): Promise<number | null> {
    try {
      return (
        (await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })))
          .ContentLength ?? null
      );
    } catch (e) {
      if ((e as { name?: string }).name === "NotFound") return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
