/**
 * privacy-engine/detection/OCRDetector.ts
 *
 * Client-side Optical Character Recognition (OCR) over screenshots to detect
 * textual PII rendered in pixels (e.g. text inside input fields, photos of IDs,
 * scanned documents, or image-embedded credentials).
 *
 * Uses tesseract.js to extract word-level and line-level bounding boxes and
 * text, then runs regex matching and label-proximity heuristics to redact
 * sensitive regions directly on the screenshot image.
 */
import type { Detector, DetectorInput, DetectionSource, SensitiveDataType, SensitiveRegion } from '../core/types';
import { normalizeImageData } from '../utils/imageUtils';
import { PATTERNS } from './patterns';

export interface RawOCRBox {
  text: string;
  confidence: number;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
}

export type CustomOCRFn = (imageSource: string) => Promise<RawOCRBox[]>;

let customOCR: CustomOCRFn | null = null;
let tesseractWorker: any = null;
let isInitializing = false;

export function setCustomOCRDetector(fn: CustomOCRFn | null): void {
  customOCR = fn;
}

export function resetOCRDetector(): void {
  customOCR = null;
  if (tesseractWorker && typeof tesseractWorker.terminate === 'function') {
    try {
      tesseractWorker.terminate();
    } catch {
      // ignore
    }
  }
  tesseractWorker = null;
  isInitializing = false;
}

const DATE_REGEX = /\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}[/.-]\d{1,2}[/.-]\d{1,2})\b/;

const SENSITIVE_LABEL_KEYWORDS: Array<{ pattern: RegExp; type: SensitiveDataType }> = [
  { pattern: /\b(full[_-]?name|first[_-]?name|last[_-]?name|name)\b/i, type: 'NAME' },
  { pattern: /\b(dob|birth|bday|date[_-]?of[_-]?birth)\b/i, type: 'DOCUMENT' },
  { pattern: /\b(mobile|phone|contact)\b/i, type: 'PHONE' },
  { pattern: /\b(passport|passport[_-]?no)\b/i, type: 'PASSPORT' },
  { pattern: /\b(pan|pan[_-]?number|pan[_-]?no)\b/i, type: 'PAN' },
  { pattern: /\b(aadhaar|aadhar|uidai)\b/i, type: 'AADHAAR' },
  { pattern: /\b(address|street|residence)\b/i, type: 'ADDRESS' },
  { pattern: /\b(email|e-mail)\b/i, type: 'EMAIL' },
  { pattern: /\b(RegID|regid)\b/i, type: 'REGID' },
];

function isValidImagePayload(rawBase64: string): boolean {
  if (!rawBase64 || rawBase64.length < 500) {
    return false;
  }
  // Check for PNG (iVBORw0KGgo), JPEG (/9j/), WebP (UklGR), GIF (R0lGOD)
  return /^(?:iVBORw0KGgo|\/9j\/|UklGR|R0lGOD)/.test(rawBase64);
}

function isServiceWorker(): boolean {
  return (
    (typeof (globalThis as any).ServiceWorkerGlobalScope !== 'undefined' &&
      typeof self !== 'undefined' &&
      self instanceof (globalThis as any).ServiceWorkerGlobalScope) ||
    (typeof (globalThis as any).importScripts === 'function' && typeof (globalThis as any).document === 'undefined')
  );
}

export async function initOCRWorker(): Promise<any> {
  if (tesseractWorker || customOCR) return tesseractWorker;
  if (isInitializing) return null;

  // In Chrome MV3, dynamic import() is disallowed by the HTML spec on ServiceWorkerGlobalScope.
  // Guard against this so the service worker never throws or logs an unhandled exception.
  if (isServiceWorker()) {
    return null;
  }

  isInitializing = true;
  try {
    const { createWorker } = await import('tesseract.js');
    tesseractWorker = await createWorker('eng');
    if (tesseractWorker && typeof tesseractWorker.on === 'function') {
      tesseractWorker.on('error', (err: any) => {
        console.warn('[OCRDetector] Worker error handled:', err?.message || err);
      });
    }
  } catch (err) {
    console.warn('[OCRDetector] Failed to initialize Tesseract worker:', err);
    tesseractWorker = null;
  } finally {
    isInitializing = false;
  }
  return tesseractWorker;
}

export class OCRDetector implements Detector {
  readonly source: DetectionSource = 'ocr';

  constructor(private minConfidence: number = 30) {}

  async detect(input: DetectorInput): Promise<SensitiveRegion[]> {
    if (!input.screenshot) return [];

    let ocrBoxes: RawOCRBox[] = [];

    if (customOCR) {
      ocrBoxes = await customOCR(input.screenshot);
    } else {
      const { dataUrl, rawBase64 } = normalizeImageData(input.screenshot);
      if (!isValidImagePayload(rawBase64)) {
        return [];
      }

      try {
        const worker = tesseractWorker || (await initOCRWorker());
        if (!worker) {
          return [];
        }

        const result = await worker.recognize(dataUrl);

        if (result?.data?.words) {
          ocrBoxes = result.data.words.map((w: any) => ({
            text: w.text || '',
            confidence: w.confidence ?? 80,
            bbox: w.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 },
          }));
        }

        // Also process full lines for label-value contextual extraction
        if (result?.data?.lines) {
          for (const line of result.data.lines) {
            const lineText = (line.text || '').trim();
            if (!lineText) continue;

            for (const { pattern } of SENSITIVE_LABEL_KEYWORDS) {
              if (pattern.test(lineText)) {
                // If line contains a label and other text (like "Name: Gourav Sarkar"),
                // find words following the label to redact
                const words = line.words || [];
                let labelFound = false;
                for (const w of words) {
                  if (pattern.test(w.text || '')) {
                    labelFound = true;
                    continue;
                  }
                  if (labelFound && (w.text || '').trim().length > 1) {
                    ocrBoxes.push({
                      text: w.text,
                      confidence: w.confidence ?? 85,
                      bbox: w.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 },
                    });
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn('[OCRDetector] OCR detection error:', err);
        return [];
      }
    }

    const regions: SensitiveRegion[] = [];
    let idCounter = 0;

    for (const box of ocrBoxes) {
      const cleanText = (box.text || '').trim();
      if (!cleanText || box.confidence < this.minConfidence) continue;

      let detectedType: SensitiveDataType | null = null;
      let matchedConfidence = Math.max(0.7, box.confidence / 100);

      // 1. Check against standard regex patterns (EMAIL, PHONE, PAN, PASSPORT, AADHAAR, etc.)
      for (const { type, regex, confidence } of PATTERNS) {
        regex.lastIndex = 0;
        if (regex.test(cleanText)) {
          detectedType = type;
          matchedConfidence = Math.min(0.98, Math.max(matchedConfidence, confidence));
          break;
        }
      }

      // 2. Check for Date of Birth / date strings (e.g. "15/08/2000", "01/05/2001")
      if (!detectedType && DATE_REGEX.test(cleanText)) {
        detectedType = 'DOCUMENT';
        matchedConfidence = 0.85;
      }

      // 3. Check for synthetic / test indicators like "[EMAIL]" or "[MASKED]" or "[REDACTED]"
      if (!detectedType && /\[(EMAIL|PHONE|NAME|PASS|REDACTED|MASKED)\]/i.test(cleanText)) {
        detectedType = 'UNKNOWN_SENSITIVE';
        matchedConfidence = 0.95;
      }

      if (detectedType) {
        regions.push({
          id: `ocr-${idCounter++}`,
          type: detectedType,
          source: this.source,
          confidence: matchedConfidence,
          action: 'REDACT',
          bbox: {
            xmin: Math.max(0, box.bbox.x0),
            ymin: Math.max(0, box.bbox.y0),
            xmax: Math.max(0, box.bbox.x1),
            ymax: Math.max(0, box.bbox.y1),
          },
        });
      }
    }

    return regions;
  }
}
