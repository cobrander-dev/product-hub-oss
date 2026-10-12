import { createHash } from "node:crypto";
import path from "node:path";

import sharp, { type Metadata, type OutputInfo } from "sharp";

import { ApplicationError } from "@/lib/application/errors";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 8_000;
export const MAX_IMAGE_PIXELS = 25_000_000;
export const NORMALIZED_IMAGE_MIME = "image/webp";

const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const allowedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export type ImageUploadInput = {
  bytes: Buffer;
  contentType: string;
  originalFilename: string;
};

export type NormalizedImage = {
  bytes: Buffer;
  mimeType: typeof NORMALIZED_IMAGE_MIME;
  sizeBytes: bigint;
  width: number;
  height: number;
  checksumSha256: string;
  originalFilename: string;
};

function hasAllowedSignature(bytes: Buffer) {
  const jpeg =
    bytes.length >= 3 &&
    bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const png =
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp =
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return jpeg || png || webp;
}

export function sanitizeOriginalFilename(value: string) {
  const basename = path.basename(value.replaceAll("\\", "/")).normalize("NFKC");
  const safe = basename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return safe || "image";
}

function reject(message: string): never {
  throw new ApplicationError("VALIDATION", message);
}

export async function normalizeImageUpload(
  input: ImageUploadInput,
): Promise<NormalizedImage> {
  if (input.bytes.length === 0) reject("图片内容为空");
  if (input.bytes.length > MAX_IMAGE_BYTES) reject("图片不能超过 10 MB");
  if (!allowedMimeTypes.has(input.contentType.toLowerCase())) {
    reject("只支持 JPEG、PNG 或 WebP 图片");
  }
  const cleanFilename = sanitizeOriginalFilename(input.originalFilename);
  if (!allowedExtensions.has(path.extname(cleanFilename).toLowerCase())) {
    reject("图片文件扩展名必须为 JPG、JPEG、PNG 或 WebP");
  }
  if (!hasAllowedSignature(input.bytes)) reject("图片文件签名无效");

  let metadata: Metadata;
  try {
    metadata = await sharp(input.bytes, {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
  } catch {
    reject("图片无法安全解码或像素数量超限");
  }

  if (!metadata.width || !metadata.height) reject("无法读取图片尺寸");
  if (!(["jpeg", "png", "webp"] as const).includes(metadata.format as never)) {
    reject("图片实际格式不受支持");
  }
  if ((metadata.pages ?? 1) !== 1) reject("不支持动画或多帧图片");
  if (
    metadata.width > MAX_IMAGE_DIMENSION ||
    metadata.height > MAX_IMAGE_DIMENSION ||
    metadata.width * metadata.height > MAX_IMAGE_PIXELS
  ) {
    reject("图片尺寸不能超过单边 8000 px 或 2500 万像素");
  }

  let output: { data: Buffer; info: OutputInfo };
  try {
    output = await sharp(input.bytes, {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
    })
      .rotate()
      .webp({ quality: 88, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    reject("图片规范化失败");
  }

  const { width, height } = output.info;
  if (
    !width ||
    !height ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    reject("规范化后的图片尺寸超限");
  }

  return {
    bytes: output.data,
    mimeType: NORMALIZED_IMAGE_MIME,
    sizeBytes: BigInt(output.data.length),
    width,
    height,
    checksumSha256: createHash("sha256").update(output.data).digest("hex"),
    originalFilename: cleanFilename,
  };
}
