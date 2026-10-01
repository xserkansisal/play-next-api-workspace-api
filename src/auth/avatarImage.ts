import sharp from "sharp";
import { HttpError } from "../errors.js";

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_OUTPUT_SIZE = 512;
export const AVATAR_CONTENT_TYPE = "image/webp";
// Larger than any real profile photo, small enough that a tiny "decompression bomb" file cannot
// make the decoder allocate gigabytes.
const MAX_INPUT_PIXELS = 50_000_000;

type AvatarFormat = "jpeg" | "png" | "webp";

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  return buffer.length >= offset + bytes.length && bytes.every((byte, index) => buffer[offset + index] === byte);
}

/** Identifies the format from the file's own bytes; the client's Content-Type and file name are ignored. */
export function sniffAvatarFormat(buffer: Buffer): AvatarFormat | undefined {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return undefined;
}

function invalidImage(): HttpError {
  return new HttpError(400, "The file is not a valid JPEG, PNG or WebP image", "AVATAR_INVALID_IMAGE");
}

/**
 * Re-encodes the upload as a square WebP. Decoding the whole image rejects corrupt files, and
 * writing a fresh image drops EXIF/GPS and any other embedded metadata (orientation is applied
 * first so phone photos are not turned sideways).
 */
export async function processAvatarImage(buffer: Buffer): Promise<Buffer> {
  if (buffer.length > AVATAR_MAX_BYTES) {
    throw new HttpError(413, "Avatar images must be 5 MB or smaller", "AVATAR_TOO_LARGE");
  }
  const format = sniffAvatarFormat(buffer);
  if (!format) {
    throw new HttpError(415, "Only JPEG, PNG and WebP images are supported", "AVATAR_UNSUPPORTED_TYPE");
  }
  try {
    const image = sharp(buffer, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS });
    const metadata = await image.metadata();
    if (metadata.format !== format) throw invalidImage();
    return await image
      .rotate()
      .resize(AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE, { fit: "cover", withoutEnlargement: false })
      .webp({ quality: 85 })
      .toBuffer();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw invalidImage();
  }
}
