import { describe, it, expect, beforeEach } from 'vitest';
import { VisionDetector, normalizeImageData, setCustomVisionDetector, resetVisionDetector, DEFAULT_SENSITIVE_LABELS } from '../../detection/VisionDetector';

describe('VisionDetector - image normalization', () => {
  it('handles raw base64 strings', () => {
    const raw = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const result = normalizeImageData(raw);
    expect(result.rawBase64).toBe(raw);
    expect(result.dataUrl).toBe(`data:image/jpeg;base64,${raw}`);
  });

  it('parses data URLs', () => {
    const raw = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const dataUrl = `data:image/png;base64,${raw}`;
    const result = normalizeImageData(dataUrl);
    expect(result.rawBase64).toBe(raw);
    expect(result.mimeType).toBe('image/png');
  });
});

describe('VisionDetector - detection & filtering', () => {
  beforeEach(() => {
    resetVisionDetector();
  });

  it('filters detections by sensitive label and maps to SensitiveRegion types', async () => {
    setCustomVisionDetector(async () => [
      { xmin: 10, ymin: 10, xmax: 50, ymax: 50, label: 'person', score: 0.92 },
      { xmin: 60, ymin: 60, xmax: 80, ymax: 80, label: 'chair', score: 0.85 },
      { xmin: 100, ymin: 100, xmax: 120, ymax: 120, label: 'face', score: 0.78 },
    ]);

    // A dedicated face model would be configured via a custom sensitiveLabels
    // list (see the "respects the configured sensitive-label set" test below);
    // the DEFAULT list only matches COCO's real "person" class.
    const detector = new VisionDetector();
    const regions = await detector.detect({ screenshot: 'dummy_base64' });

    expect(regions).toHaveLength(1);
    expect(regions.find(r => r.type === 'PERSON')).toBeDefined();
    expect(regions.every(r => r.action === 'BLUR')).toBe(true);
  });

  it('returns no regions when nothing sensitive is detected', async () => {
    setCustomVisionDetector(async () => []);
    const detector = new VisionDetector();
    const regions = await detector.detect({ screenshot: 'dummy_base64' });
    expect(regions).toEqual([]);
  });

  it('returns [] (not an error) when no screenshot was provided at all', async () => {
    setCustomVisionDetector(async () => {
      throw new Error('should not be called');
    });
    const detector = new VisionDetector();
    const regions = await detector.detect({});
    expect(regions).toEqual([]);
  });

  it('FAILS CLOSED: throws when a screenshot is provided but the model errors, instead of silently returning []', async () => {
    setCustomVisionDetector(async () => {
      throw new Error('inference crashed');
    });
    const detector = new VisionDetector();
    await expect(detector.detect({ screenshot: 'dummy_base64' })).rejects.toThrow('inference crashed');
  });

  it('respects the configured sensitive-label set', async () => {
    setCustomVisionDetector(async () => [{ xmin: 0, ymin: 0, xmax: 10, ymax: 10, label: 'document', score: 0.9 }]);
    const detector = new VisionDetector([...DEFAULT_SENSITIVE_LABELS, 'document']);
    const regions = await detector.detect({ screenshot: 'dummy_base64' });
    expect(regions).toHaveLength(1);
  });

  it('can be configured for a face-capable model by passing an explicit label list (not the default)', async () => {
    setCustomVisionDetector(async () => [{ xmin: 5, ymin: 5, xmax: 25, ymax: 25, label: 'face', score: 0.8 }]);
    const detector = new VisionDetector(['face']);
    const regions = await detector.detect({ screenshot: 'dummy_base64' });
    expect(regions).toHaveLength(1);
    expect(regions[0].type).toBe('FACE');
  });
});
