import { describe, it, expect } from 'vitest';
import { DetectionFusion } from '../../fusion/DetectionFusion';
import type { SensitiveRegion } from '../../core/types';

describe('DetectionFusion', () => {
  it('merges DOM + regex detections that hit the same node/field into one region with boosted confidence', () => {
    const domRegion: SensitiveRegion = {
      id: 'd1',
      type: 'EMAIL',
      source: 'dom',
      confidence: 0.9,
      action: 'REDACT',
      domNodeId: 'e1',
      domField: 'attributes.value',
    };
    const regexRegion: SensitiveRegion = {
      id: 'r1',
      type: 'EMAIL',
      source: 'regex',
      confidence: 0.97,
      action: 'REDACT',
      domNodeId: 'e1',
      domField: 'attributes.value',
    };

    const fused = new DetectionFusion().fuse([domRegion, regexRegion]);

    expect(fused).toHaveLength(1);
    expect(fused[0].mergedSources).toEqual(expect.arrayContaining(['dom', 'regex']));
    expect(fused[0].confidence).toBeGreaterThan(0.97);
  });

  it('keeps detections on different nodes/fields separate', () => {
    const a: SensitiveRegion = { id: 'a', type: 'EMAIL', source: 'regex', confidence: 0.9, action: 'REDACT', domNodeId: 'e1', domField: 'text' };
    const b: SensitiveRegion = { id: 'b', type: 'PHONE', source: 'regex', confidence: 0.8, action: 'REDACT', domNodeId: 'e2', domField: 'text' };

    const fused = new DetectionFusion().fuse([a, b]);
    expect(fused).toHaveLength(2);
  });

  it('merges overlapping vision bounding boxes (IoU above threshold) for the same detection', () => {
    const a: SensitiveRegion = {
      id: 'v1',
      type: 'FACE',
      source: 'vision',
      confidence: 0.8,
      action: 'BLUR',
      bbox: { xmin: 10, ymin: 10, xmax: 50, ymax: 50 },
    };
    const b: SensitiveRegion = {
      id: 'v2',
      type: 'FACE',
      source: 'vision',
      confidence: 0.75,
      action: 'BLUR',
      bbox: { xmin: 12, ymin: 12, xmax: 52, ymax: 52 },
    };

    const fused = new DetectionFusion().fuse([a, b]);
    expect(fused).toHaveLength(1);
  });

  it('does not merge vision boxes that barely overlap', () => {
    const a: SensitiveRegion = {
      id: 'v1',
      type: 'FACE',
      source: 'vision',
      confidence: 0.8,
      action: 'BLUR',
      bbox: { xmin: 0, ymin: 0, xmax: 10, ymax: 10 },
    };
    const b: SensitiveRegion = {
      id: 'v2',
      type: 'FACE',
      source: 'vision',
      confidence: 0.75,
      action: 'BLUR',
      bbox: { xmin: 100, ymin: 100, xmax: 110, ymax: 110 },
    };

    const fused = new DetectionFusion().fuse([a, b]);
    expect(fused).toHaveLength(2);
  });

  it('passes through unanchored (free-text) detections without merging', () => {
    const a: SensitiveRegion = { id: 'x1', type: 'EMAIL', source: 'regex', confidence: 0.9, action: 'REDACT' };
    const b: SensitiveRegion = { id: 'x2', type: 'PHONE', source: 'regex', confidence: 0.8, action: 'REDACT' };
    const fused = new DetectionFusion().fuse([a, b]);
    expect(fused).toHaveLength(2);
  });
});
