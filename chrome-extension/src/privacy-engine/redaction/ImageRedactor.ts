/**
 * privacy-engine/redaction/ImageRedactor.ts
 *
 * Draws solid black rectangles over sensitive bounding boxes on an
 * OffscreenCanvas. Migrated from `chrome-extension/src/redaction/visionSanitizer.ts`
 * (pre-existing project code)'s `redactImageWithCanvas`.
 *
 * Behavioural fix vs. the original (Part 6, fail-closed): if there ARE boxes to
 * redact but the canvas APIs are unavailable, this now THROWS instead of
 * returning the original (unredacted) image. The original screenshot must never
 * leave the device with known-sensitive regions still visible.
 */
import type { BoundingBox } from '../core/types';
import { normalizeImageData } from '../utils/imageUtils';

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export class ImageRedactor {
  /**
   * Redacts `boxes` on top of `imageInput`. If `boxes` is empty, returns the
   * input unchanged (nothing to redact, so no privacy loss). If `boxes` is
   * non-empty and redaction cannot be performed, THROWS.
   */
  async redact(imageInput: string, boxes: BoundingBox[]): Promise<string> {
    if (!boxes || boxes.length === 0) {
      return imageInput;
    }

    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
      throw new Error(
        'Image redaction unavailable in this environment (OffscreenCanvas/createImageBitmap missing) ' +
          `but ${boxes.length} sensitive region(s) were detected — refusing to return an unredacted screenshot.`,
      );
    }

    const { rawBase64, mimeType } = normalizeImageData(imageInput);
    const bytes = base64ToUint8Array(rawBase64);
    const blob = new Blob([bytes], { type: mimeType });
    const imageBitmap = await createImageBitmap(blob);

    const width = imageBitmap.width;
    const height = imageBitmap.height;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get 2D context from OffscreenCanvas; refusing to return an unredacted screenshot.');
    }

    ctx.drawImage(imageBitmap, 0, 0);
    ctx.fillStyle = '#000000';
    for (const box of boxes) {
      const x = Math.max(0, Math.floor(box.xmin));
      const y = Math.max(0, Math.floor(box.ymin));
      const w = Math.min(width - x, Math.ceil(box.xmax - box.xmin));
      const h = Math.min(height - y, Math.ceil(box.ymax - box.ymin));
      if (w > 0 && h > 0) {
        ctx.fillRect(x, y, w, h);
      }
    }

    const outputBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    const arrayBuffer = await outputBlob.arrayBuffer();
    const redactedBase64 = arrayBufferToBase64(arrayBuffer);

    return imageInput.trim().startsWith('data:') ? `data:image/jpeg;base64,${redactedBase64}` : redactedBase64;
  }
}
