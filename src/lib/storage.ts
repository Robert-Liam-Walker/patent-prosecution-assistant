// Cloudflare R2 (S3-compatible) — uploaded case documents.
// For dev without R2 keys, falls back to local ./uploads/.

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET || "patent-prosecution-docs";

const remoteConfigured = !!(accountId && accessKeyId && secretAccessKey);

const s3 = remoteConfigured
  ? new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
    })
  : null;

const LOCAL_DIR = path.resolve(process.cwd(), "uploads");

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<{ key: string; storage: "r2" | "local" }> {
  if (s3) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { key, storage: "r2" };
  }

  // Local fallback for dev without R2 keys.
  const fullPath = path.join(LOCAL_DIR, key);
  if (!existsSync(path.dirname(fullPath))) {
    await mkdir(path.dirname(fullPath), { recursive: true });
  }
  await writeFile(fullPath, body);
  return { key, storage: "local" };
}

export async function getObject(key: string): Promise<Buffer> {
  if (s3) {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
  return readFile(path.join(LOCAL_DIR, key));
}
