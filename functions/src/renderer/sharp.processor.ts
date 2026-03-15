import sharp from "sharp";

export interface ProcessOptions {
  grayscale: boolean;
  width?: number;
  height?: number;
}

export interface ProcessResult {
  png: Buffer;
  jpg: Buffer;
}

/**
 * Processes a PNG screenshot for e-ink display:
 * - Converts to 8-bit grayscale
 * - Resizes to exact dimensions if needed
 * - Outputs optimized PNG (for quality) and JPG (for smaller size)
 */
export async function processForEink(
  inputPng: Buffer,
  options: ProcessOptions
): Promise<ProcessResult> {
  let pipeline = sharp(inputPng);

  if (options.grayscale) {
    pipeline = pipeline.grayscale();
  }

  if (options.width && options.height) {
    pipeline = pipeline.resize(options.width, options.height, {
      fit: "cover",
      position: "top",
    });
  }

  // 8-bit grayscale PNG — best quality for e-ink
  const png = await pipeline
    .clone()
    .png({ compressionLevel: 9 })
    .toBuffer();

  // JPEG — smaller file size for slower connections
  const jpg = await pipeline
    .clone()
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();

  return { png, jpg };
}
