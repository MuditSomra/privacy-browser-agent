import { describe, it, expect } from 'vitest';
import { NavigatorPrompt } from '../navigator';
import { PrivacyBlockedError } from '../../agents/errors';
import { DOMElementNode, DOMTextNode } from '@src/background/browser/dom/views';
import { resetVisionDetector, setCustomVisionDetector } from '@src/privacy-engine/detection/VisionDetector';
import type { AgentContext } from '@src/background/agent/types';
import type { BrowserState } from '@src/background/browser/views';

// Secrets that must NEVER appear anywhere in the final HumanMessage.
const RAW_PASSWORD = 'hunter2-super-secret';
const RAW_EMAIL = 'jane.doe@example.com';
const RAW_URL_SECRET = 'user@leak.example.com'; // planted inside a tab URL's query string
const RAW_TITLE_SECRET = 'title.owner@example.com'; // planted inside a tab title
const RAW_ACTION_RESULT_SECRET = 'extracted-secret@example.com';
const RAW_ERROR_SECRET = 'error-leak@example.com';

function buildDomTree() {
  const passwordInput = new DOMElementNode({
    tagName: 'input',
    xpath: '//input[1]',
    attributes: { type: 'password', value: RAW_PASSWORD },
    children: [],
    isVisible: true,
    highlightIndex: 0,
  });
  const emailText = new DOMTextNode(`Contact: ${RAW_EMAIL}`, true);
  return new DOMElementNode({
    tagName: 'form',
    xpath: '//form[1]',
    attributes: {},
    children: [passwordInput, emailText],
    isVisible: true,
  });
}

function buildBrowserState(overrides: Partial<BrowserState> = {}): BrowserState {
  return {
    url: `https://example.com/callback?leaked=${encodeURIComponent(RAW_URL_SECRET)}`,
    title: `Account settings for ${RAW_TITLE_SECRET}`,
    tabId: 1,
    elementTree: buildDomTree(),
    selectorMap: new Map(),
    screenshot: null,
    pixelsAbove: 0,
    pixelsBelow: 0,
    scrollY: 0,
    scrollHeight: 1000,
    visualViewportHeight: 800,
    tabs: [
      { id: 1, url: `https://example.com/callback?leaked=${encodeURIComponent(RAW_URL_SECRET)}`, title: `Account settings for ${RAW_TITLE_SECRET}` },
      { id: 2, url: 'https://example.com/other', title: 'Other tab' },
    ],
    ...overrides,
  } as unknown as BrowserState;
}

function buildAgentContext(browserState: BrowserState, actionResults: Array<{ extractedContent?: string; error?: string }> = []): AgentContext {
  return {
    browserContext: { getState: async () => browserState },
    options: { useVision: false, includeAttributes: ['type', 'value'] },
    stepInfo: { stepNumber: 0, maxSteps: 10 },
    actionResults,
  } as unknown as AgentContext;
}

describe('prompts/base.ts network boundary', () => {
  it('the outgoing HumanMessage never contains raw DOM value/text, url, title, tab info, or action-result content', async () => {
    const browserState = buildBrowserState();
    const context = buildAgentContext(browserState, [
      { extractedContent: `Found account: ${RAW_ACTION_RESULT_SECRET}` },
      { error: `Failed while processing ${RAW_ERROR_SECRET}\nStack trace line 2` },
    ]);

    const prompt = new NavigatorPrompt();
    const message = await prompt.getUserMessage(context);

    const serialized = JSON.stringify(message.content);

    expect(serialized).not.toContain(RAW_PASSWORD);
    expect(serialized).not.toContain(RAW_EMAIL);
    expect(serialized).not.toContain(RAW_URL_SECRET);
    expect(serialized).not.toContain(RAW_TITLE_SECRET);
    expect(serialized).not.toContain(RAW_ACTION_RESULT_SECRET);
    expect(serialized).not.toContain(RAW_ERROR_SECRET);

    // Positive check: sanitized placeholders ARE present, proving the
    // message was actually built from PrivacyResult, not just stripped blank.
    expect(serialized).toContain('REDACTED');
  });

  it('throws PrivacyBlockedError (and produces no HumanMessage at all) when the privacy engine fails closed', async () => {
    resetVisionDetector();
    setCustomVisionDetector(async () => {
      throw new Error('simulated vision failure');
    });
    try {
      const browserState = buildBrowserState({ screenshot: 'aGVsbG8=' });
      const context = buildAgentContext(browserState);
      context.options.useVision = true;

      const prompt = new NavigatorPrompt();
      await expect(prompt.getUserMessage(context)).rejects.toBeInstanceOf(PrivacyBlockedError);
    } finally {
      resetVisionDetector();
    }
  });

  it('a page with no PII at all still routes through the privacy engine and produces a normal message', async () => {
    const benignInput = new DOMElementNode({
      tagName: 'button',
      xpath: '//button[1]',
      attributes: { type: 'submit' },
      children: [new DOMTextNode('Add to cart', true)],
      isVisible: true,
      highlightIndex: 0,
    });
    const browserState = buildBrowserState({
      elementTree: benignInput,
      url: 'https://shop.example.com/cart',
      title: 'Your Cart',
      tabs: [{ id: 1, url: 'https://shop.example.com/cart', title: 'Your Cart' }],
    });
    const context = buildAgentContext(browserState);

    const prompt = new NavigatorPrompt();
    const message = await prompt.getUserMessage(context);
    const serialized = JSON.stringify(message.content);

    expect(serialized).toContain('Add to cart');
    expect(serialized).toContain('shop.example.com');
  });
});
