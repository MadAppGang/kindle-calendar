import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const REGION = process.env["AWS_REGION"] || "ap-southeast-2";
const s3 = new S3Client({ region: REGION });

export interface S3UploadOptions {
  bucket: string;
  key: string;
  contentType: string;
  cacheControl?: string;
}

export async function uploadToS3(data: Buffer, options: S3UploadOptions): Promise<string> {
  await s3.send(new PutObjectCommand({
    Bucket: options.bucket,
    Key: options.key,
    Body: data,
    ContentType: options.contentType,
    CacheControl: options.cacheControl ?? "public, max-age=300",
  }));

  return `https://${options.bucket}.s3.${REGION}.amazonaws.com/${options.key}`;
}
