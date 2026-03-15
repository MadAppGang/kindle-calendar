export interface UploadOptions {
  bucketName: string;
  objectName: string;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface UploadResult {
  publicUrl: string;
  objectName: string;
}

/**
 * Uploads a buffer to Google Cloud Storage and writes metadata.
 *
 * @stub - Not yet implemented.
 */
export async function uploadToGcs(
  _data: Buffer,
  _options: UploadOptions
): Promise<UploadResult> {
  throw new Error(
    "GCS uploader not yet implemented. " +
    "Will use @google-cloud/storage to upload the rendered image and write metadata."
  );
}
