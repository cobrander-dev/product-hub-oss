import { randomFillSync } from "node:crypto";

import { expect, test } from "@playwright/test";
import sharp from "sharp";

import {
  MAX_IMAGE_BYTES,
  normalizeImageUpload,
} from "@/lib/storage/image-normalization";

test("normalizes near-limit images and a small concurrent batch", async () => {
  test.setTimeout(180_000);

  const noisyPixels = Buffer.allocUnsafe(2_200 * 1_500 * 3);
  randomFillSync(noisyPixels);
  const nearSizeLimit = await sharp(noisyPixels, {
    raw: { width: 2_200, height: 1_500, channels: 3 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  expect(nearSizeLimit.length).toBeGreaterThan(9 * 1024 * 1024);
  expect(nearSizeLimit.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);

  const rssBefore = process.memoryUsage().rss;
  const nearSizeStarted = performance.now();
  const normalizedNearSize = await normalizeImageUpload({
    bytes: nearSizeLimit,
    contentType: "image/png",
    originalFilename: "near-10mb.png",
  });
  const nearSizeMs = Math.round(performance.now() - nearSizeStarted);
  expect(normalizedNearSize).toMatchObject({ width: 2_200, height: 1_500 });

  const pixelBoundary = await sharp({
    create: {
      width: 5_000,
      height: 5_000,
      channels: 3,
      background: { r: 32, g: 96, b: 160 },
    },
  })
    .png()
    .toBuffer();
  const boundaryStarted = performance.now();
  const normalizedBoundary = await normalizeImageUpload({
    bytes: pixelBoundary,
    contentType: "image/png",
    originalFilename: "pixel-boundary.png",
  });
  const boundaryMs = Math.round(performance.now() - boundaryStarted);
  expect(normalizedBoundary).toMatchObject({ width: 5_000, height: 5_000 });

  const concurrentInput = await sharp({
    create: {
      width: 2_000,
      height: 2_000,
      channels: 3,
      background: { r: 64, g: 128, b: 192 },
    },
  })
    .png()
    .toBuffer();
  const concurrentStarted = performance.now();
  const concurrent = await Promise.all(
    Array.from({ length: 3 }, (_, index) =>
      normalizeImageUpload({
        bytes: concurrentInput,
        contentType: "image/png",
        originalFilename: `concurrent-${index}.png`,
      }),
    ),
  );
  const concurrentMs = Math.round(performance.now() - concurrentStarted);
  expect(concurrent).toHaveLength(3);
  const rssDeltaMiB = Math.round(
    (process.memoryUsage().rss - rssBefore) / 1024 / 1024,
  );
  console.log(
    `PHASE11_IMAGE_LOAD near_size_bytes=${nearSizeLimit.length} near_size_ms=${nearSizeMs} boundary_ms=${boundaryMs} concurrent_ms=${concurrentMs} rss_delta_mib=${rssDeltaMiB}`,
  );
});
