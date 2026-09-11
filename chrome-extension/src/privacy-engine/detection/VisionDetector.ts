/**
 * privacy-engine/detection/VisionDetector.ts
 *
 * Local OBJECT detection over screenshots (faces/persons/document-like
 * regions), using an in-browser ONNX model via Transformers.js (WebGPU,
 * falling back to WASM).
 *
 * IMPORTANT — WHAT THIS DOES NOT DO: the default model (`Xenova/yolos-tiny`)
 * is an object detector, not an OCR/text-recognition model. It cannot read
 * and does not detect PII that exists as TEXT rendered inside a screenshot —
 * e.g. a password visibly typed into a field, an email address printed on a
 * scanned document photo, or a name baked into an infographic image. Do not
 * treat "vision analysis ran" as "textual content in this screenshot was
 * checked for PII"; it was not. Two things currently reduce this gap without
 * OCR: (1) DOM-detected sensitive fields (password/email/etc.) that carry
 * known on-screen coordinates are ALSO blacked out on the screenshot by
 * PrivacyEngine, independent of this detector — see `GenericDomNode.bbox`
 * and PrivacyEngine's redaction step; (2) see
 * `privacy-engine/docs/screenshot-text-pii.md` for the design of closing the
 * remaining gap (text with no corresponding DOM node) via local OCR, which is
 * intentionally NOT implemented yet, to keep dependencies minimal until
 * evaluation shows it's actually needed.
 *
 * Migrated from the original `chrome-extension/src/redaction/visionSanitizer.ts`
 * (pre-existing project code). The load/inference plumbing is unchanged; the
 * behavioural fix is that this version FAILS CLOSED (Part 6): if the model
 * cannot be loaded or inference throws, `detect()` throws instead of silently
 * returning an empty result. The old code's silent "no boxes found" on model-load
 * failure meant a screenshot could go out completely unredacted with no signal
 * that vision analysis never actually ran — that is exactly the failure mode
 * Part 6 exists to prevent.
 *
 * We deliberately do not claim this tiny object-detection model reliably finds
 * every sensitive visual element (e.g. a photo of a physical ID card lying on a
 * desk, or a face partially occluded). It's a best-effort layer, and the DOM +
 * regex detectors do not depend on it for text-based PII.
 */
import type { Detector, DetectorInput, DetectionSource, SensitiveDataType, SensitiveRegion } from '../core/types';
import { normalizeImageData } from '../utils/imageUtils';

export { normalizeImageData };
export type { NormalizedImageData } from '../utils/imageUtils';

// COCO's 80 classes are what `Xenova/yolos-tiny` (the default model) actually
// emits, and COCO's ONLY people/PII-adjacent class is literally named
// "person" — there is no "face", "card", "id", or "human" class in COCO, so
// with the default model those labels below will never actually fire. They're
// kept in `LABEL_TO_TYPE` (not `DEFAULT_SENSITIVE_LABELS`) so that swapping in
// a different `modelName` (e.g. a dedicated face/document detector) via
// `initVisionDetector(modelName)` or `setCustomVisionDetector` picks them up
// automatically, without overclaiming what the DEFAULT model can see today.
export const DEFAULT_SENSITIVE_LABELS = ['person'];
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.25;

const LABEL_TO_TYPE: Record<string, SensitiveDataType> = {
  person: 'PERSON',
  human: 'PERSON',
  face: 'FACE',
  card: 'DOCUMENT',
  id: 'DOCUMENT',
};

interface RawBox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  label?: string;
  score?: number;
}

type CustomDetectorFn = (imageSource: string) => Promise<RawBox[]>;

/** Transformers.js's object-detection pipeline callable: (image, options) -> detections. */
type ObjectDetectionPipeline = (
  image: string,
  options?: { threshold?: number; percentage?: boolean },
) => Promise<
  | Array<{ box?: Partial<RawBox>; label?: string; score?: number }>
  | { box?: Partial<RawBox>; label?: string; score?: number }
>;

let detectorPipeline: ObjectDetectionPipeline | null = null;
let isInitializing = false;
let initError: Error | null = null;
let customDetector: CustomDetectorFn | null = null;

import { pipeline, env } from '@huggingface/transformers';

export async function initVisionDetector(modelName = 'Xenova/yolos-tiny'): Promise<void> {
  if (detectorPipeline || customDetector) return;
  if (isInitializing) return;

  isInitializing = true;

  try {
    env.allowLocalModels = false;
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.proxy = false;
      env.backends.onnx.wasm.numThreads = 1;
    }
    detectorPipeline = (await pipeline('object-detection', modelName, {
      device: 'webgpu',
    })) as unknown as ObjectDetectionPipeline;
    initError = null;
  } catch (webgpuError) {
    try {
      env.allowLocalModels = false;
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.proxy = false;
        env.backends.onnx.wasm.numThreads = 1;
      }
      detectorPipeline = (await pipeline('object-detection', modelName, {
        device: 'wasm',
      })) as unknown as ObjectDetectionPipeline;
      initError = null;
    } catch (wasmError) {
      initError = wasmError instanceof Error ? wasmError : new Error(String(wasmError));
    }
  } finally {
    isInitializing = false;
  }
}

/** Test/alternative-model hook. */
export function setCustomVisionDetector(fn: CustomDetectorFn | null): void {
  customDetector = fn;
}

export function resetVisionDetector(): void {
  detectorPipeline = null;
  customDetector = null;
  isInitializing = false;
  initError = null;
}

/**
 * Runs local object detection on a screenshot. THROWS (does not return []) if
 * the model is unavailable or inference fails — callers must treat that as an
 * analysis failure, not "nothing sensitive found". See PrivacyEngine's
 * fail-closed handling.
 */
export class VisionDetector implements Detector {
  readonly source: DetectionSource = 'vision';

  constructor(
    private sensitiveLabels: string[] = DEFAULT_SENSITIVE_LABELS,
    private threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
  ) {}

  async detect(input: DetectorInput): Promise<SensitiveRegion[]> {
    if (!input.screenshot) return [];

    let boxes: RawBox[];
    if (customDetector) {
      boxes = await customDetector(input.screenshot);
    } else {
      if (!detectorPipeline) {
        await initVisionDetector();
      }
      if (!detectorPipeline) {
        throw new Error(
          `Vision model unavailable, cannot analyze screenshot for sensitive content: ${initError?.message ?? 'unknown error'}`,
        );
      }
      const { dataUrl } = normalizeImageData(input.screenshot);
      const rawResults = await detectorPipeline(dataUrl, { threshold: this.threshold, percentage: false });
      const resultsArray = Array.isArray(rawResults) ? rawResults : [rawResults];
      boxes = resultsArray.map(item => ({
        xmin: item.box?.xmin ?? 0,
        ymin: item.box?.ymin ?? 0,
        xmax: item.box?.xmax ?? 0,
        ymax: item.box?.ymax ?? 0,
        label: item.label,
        score: item.score,
      }));
    }

    const regions: SensitiveRegion[] = [];
    let n = 0;
    for (const box of boxes) {
      const label = (box.label || '').toLowerCase();
      const score = box.score ?? 1.0;
      const isSensitive = this.sensitiveLabels.some(s => label.includes(s.toLowerCase()));
      if (!isSensitive || score < this.threshold) continue;

      const type = LABEL_TO_TYPE[label] ?? 'UNKNOWN_SENSITIVE';
      regions.push({
        id: `vision-${n++}`,
        type,
        source: this.source,
        confidence: score,
        action: type === 'FACE' || type === 'PERSON' ? 'BLUR' : 'REDACT',
        bbox: {
          xmin: Math.max(0, box.xmin),
          ymin: Math.max(0, box.ymin),
          xmax: Math.max(0, box.xmax),
          ymax: Math.max(0, box.ymax),
        },
      });
    }
    return regions;
  }
}
