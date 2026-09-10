import { describe, it, expect, vi } from 'vitest';
import { ImageRedactor } from '../../redaction/ImageRedactor';

describe('ImageRedactor', () => {
  it('returns the input unchanged when there are no boxes to redact', async () => {
    const redactor = new ImageRedactor();
    const original = 'raw_screenshot_data';
    const result = await redactor.redact(original, []);
    expect(result).toBe(original);
  });

  it('FAILS CLOSED: throws (does not return the raw image) when boxes exist but canvas APIs are unavailable', async () => {
    const redactor = new ImageRedactor();
    // In the Node test environment, OffscreenCanvas/createImageBitmap are undefined.
    await expect(
      redactor.redact('raw_screenshot_data', [{ xmin: 0, ymin: 0, xmax: 100, ymax: 100 }]),
    ).rejects.toThrow(/refusing to return an unredacted screenshot/);
  });

  it('draws a black rectangle over each box when canvas APIs are available', async () => {
    const fillRectSpy = vi.fn();
    const drawImageSpy = vi.fn();

    const mockCtx = { drawImage: drawImageSpy, fillRect: fillRectSpy, fillStyle: '' };
    const mockCanvas = {
      getContext: vi.fn().mockReturnValue(mockCtx),
      convertToBlob: vi.fn().mockResolvedValue({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
    };

    const originalOffscreen = globalThis.OffscreenCanvas;
    const originalCreateBitmap = globalThis.createImageBitmap;

    try {
      // Mocking canvas for testing
      globalThis.OffscreenCanvas = vi.fn().mockImplementation(() => mockCanvas);
      // Mocking createImageBitmap
      globalThis.createImageBitmap = vi.fn().mockResolvedValue({ width: 800, height: 600 });

      const redactor = new ImageRedactor();
      const output = await redactor.redact('AQID', [{ xmin: 50, ymin: 60, xmax: 150, ymax: 200 }]);

      expect(drawImageSpy).toHaveBeenCalled();
      expect(mockCtx.fillStyle).toBe('#000000');
      expect(fillRectSpy).toHaveBeenCalledWith(50, 60, 100, 140);
      expect(output).toBeTruthy();
    } finally {
      globalThis.OffscreenCanvas = originalOffscreen;
      globalThis.createImageBitmap = originalCreateBitmap;
    }
  });
});
