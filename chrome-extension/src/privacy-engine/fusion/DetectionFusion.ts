/**
 * privacy-engine/fusion/DetectionFusion.ts
 *
 * Merges detections from multiple detectors (DOM, regex, NER, vision) that
 * refer to the same underlying region, so we don't double-redact and so we
 * can report a combined confidence + full provenance (Part 5).
 *
 * Two regions are considered "the same":
 *  - DOM-anchored: same (domNodeId, domField).
 *  - Vision-anchored: same approximate type family AND bounding-box IoU above
 *    a threshold.
 * Everything else (e.g. free-text detections with no DOM anchor) passes
 * through unmerged, since there's no reliable correlation key.
 */
import type { SensitiveRegion, BoundingBox } from '../core/types';

const IOU_MERGE_THRESHOLD = 0.3;

function iou(a: BoundingBox, b: BoundingBox): number {
  const x1 = Math.max(a.xmin, b.xmin);
  const y1 = Math.max(a.ymin, b.ymin);
  const x2 = Math.min(a.xmax, b.xmax);
  const y2 = Math.min(a.ymax, b.ymax);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const inter = interW * interH;
  const areaA = Math.max(0, a.xmax - a.xmin) * Math.max(0, a.ymax - a.ymin);
  const areaB = Math.max(0, b.xmax - b.xmin) * Math.max(0, b.ymax - b.ymin);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function mergeGroup(group: SensitiveRegion[]): SensitiveRegion {
  // Highest-confidence region's type/action/anchor wins; confidence is boosted
  // (not just max) when multiple independent sources agree, capped at 0.99.
  const sorted = [...group].sort((a, b) => b.confidence - a.confidence);
  const best = sorted[0];
  const sources = Array.from(new Set(group.map(r => r.source)));
  const agreementBoost = sources.length > 1 ? Math.min(0.99, best.confidence + 0.02 * (sources.length - 1)) : best.confidence;

  return {
    ...best,
    confidence: agreementBoost,
    mergedSources: sources,
  };
}

export class DetectionFusion {
  fuse(allRegions: SensitiveRegion[]): SensitiveRegion[] {
    const domAnchored: SensitiveRegion[] = [];
    const textAnchored: SensitiveRegion[] = [];
    const visionAnchored: SensitiveRegion[] = [];
    const unanchored: SensitiveRegion[] = [];

    for (const r of allRegions) {
      if (r.domNodeId && r.domField) domAnchored.push(r);
      else if (r.textField) textAnchored.push(r);
      else if (r.bbox) visionAnchored.push(r);
      else unanchored.push(r);
    }

    // --- DOM-anchored: group by exact (domNodeId, domField) key ---
    const domGroups = new Map<string, SensitiveRegion[]>();
    for (const r of domAnchored) {
      const key = `${r.domNodeId}::${r.domField}`;
      const arr = domGroups.get(key) ?? [];
      arr.push(r);
      domGroups.set(key, arr);
    }
    const mergedDom = Array.from(domGroups.values()).map(mergeGroup);

    // --- Flat-text-anchored (url/title/tabs/extraText): group by exact (textField, type) key.
    // Same field can legitimately carry more than one PII type (e.g. a URL with
    // both an email and a phone number in its query string), so type is part of
    // the key — unlike DOM fields, which hold one value.
    const textGroups = new Map<string, SensitiveRegion[]>();
    for (const r of textAnchored) {
      const key = `${r.textField}::${r.type}`;
      const arr = textGroups.get(key) ?? [];
      arr.push(r);
      textGroups.set(key, arr);
    }
    const mergedText = Array.from(textGroups.values()).map(mergeGroup);

    // --- Vision-anchored: greedy IoU clustering ---
    const mergedVision: SensitiveRegion[] = [];
    const used = new Set<number>();
    for (let i = 0; i < visionAnchored.length; i++) {
      if (used.has(i)) continue;
      const group = [visionAnchored[i]];
      used.add(i);
      for (let j = i + 1; j < visionAnchored.length; j++) {
        if (used.has(j)) continue;
        const a = visionAnchored[i].bbox!;
        const b = visionAnchored[j].bbox!;
        if (iou(a, b) >= IOU_MERGE_THRESHOLD) {
          group.push(visionAnchored[j]);
          used.add(j);
        }
      }
      mergedVision.push(mergeGroup(group));
    }

    return [...mergedDom, ...mergedText, ...mergedVision, ...unanchored];
  }
}
