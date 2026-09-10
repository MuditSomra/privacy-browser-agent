import { describe, it, expect } from 'vitest';
import { DOMElementNode, DOMTextNode } from '@src/background/browser/dom/views';
import { NanoBrowserAdapter } from '../../adapters/nanobrowser/NanoBrowserAdapter';
import { resetVisionDetector, setCustomVisionDetector } from '../../detection/VisionDetector';
import type { BrowserState } from '@src/background/browser/views';

function buildBrowserState(overrides: Partial<BrowserState> = {}): BrowserState {
  const passwordInput = new DOMElementNode({
    tagName: 'input',
    xpath: '//input[1]',
    attributes: { type: 'password', value: 'hunter2' },
    children: [],
    isVisible: true,
    highlightIndex: 0,
  });
  const emailText = new DOMTextNode('Reach us at support@nanobrowser.ai', true);
  const root = new DOMElementNode({
    tagName: 'form',
    xpath: '//form[1]',
    attributes: {},
    children: [passwordInput, emailText],
    isVisible: true,
  });

  return {
    url: 'https://example.com/login',
    title: 'Login',
    tabId: 1,
    elementTree: root,
    selectorMap: new Map(),
    screenshot: null,
    pixelsAbove: 0,
    pixelsBelow: 0,
    scrollY: 0,
    scrollHeight: 1000,
    visualViewportHeight: 800,
    ...overrides,
  } as unknown as BrowserState;
}

describe('NanoBrowserAdapter', () => {
  it('returns sanitized elementsText with PII redacted, using clickableElementsToString for serialization', async () => {
    const adapter = new NanoBrowserAdapter();
    const browserState = buildBrowserState();

    const result = await adapter.sanitizeBrowserState(browserState, ['type', 'value']);

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    // Truncated to 15 chars by NanoBrowser's own clickableElementsToString
    // (capTextLength) — see the note in domTranslate.test.ts. Still safe.
    expect(result.elementsText).toContain('[PASSWORD_REDAC');
    expect(result.elementsText).not.toContain('hunter2');
    expect(result.sensitiveRegions.length).toBeGreaterThan(0);
    expect(result.screenshot).toBeNull();
  });

  it('fails closed when a screenshot is present and vision analysis fails (deterministic: injected failure, not a real network dependency)', async () => {
    resetVisionDetector();
    setCustomVisionDetector(async () => {
      throw new Error('model not loaded (simulated)');
    });
    try {
      const adapter = new NanoBrowserAdapter();
      const browserState = buildBrowserState({ screenshot: 'aGVsbG8=' });

      const result = await adapter.sanitizeBrowserState(browserState, null);

      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      expect(result.reason).toContain('Vision analysis');
    } finally {
      resetVisionDetector();
    }
  });
});
