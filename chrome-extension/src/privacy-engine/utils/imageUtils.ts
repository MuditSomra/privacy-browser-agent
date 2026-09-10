/**
 * privacy-engine/utils/imageUtils.ts
 *
 * Standalone, dependency-free image string normalization utilities.
 */

export interface NormalizedImageData {
  dataUrl: string;
  rawBase64: string;
  mimeType: string;
}

/**
 * Normalizes an image string (data URL or raw base64) into a structured object
 * containing the full data URL, raw base64 payload, and detected MIME type.
 */
export function normalizeImageData(input: string): NormalizedImageData {
  const trimmed = input.trim();
  if (trimmed.startsWith('data:')) {
    const commaIndex = trimmed.indexOf(',');
    const prefix = trimmed.slice(0, commaIndex);
    const rawBase64 = trimmed.slice(commaIndex + 1);
    const mimeMatch = prefix.match(/data:([^;]+)/);
    return { dataUrl: trimmed, rawBase64, mimeType: mimeMatch ? mimeMatch[1] : 'image/jpeg' };
  }
  return { dataUrl: `data:image/jpeg;base64,${trimmed}`, rawBase64: trimmed, mimeType: 'image/jpeg' };
}
