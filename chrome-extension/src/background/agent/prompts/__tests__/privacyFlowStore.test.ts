import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

const mockStorage = new Map<string, any>();

beforeAll(() => {
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (keys: string[]) => {
          const result: Record<string, any> = {};
          for (const k of keys) {
            if (mockStorage.has(k)) {
              result[k] = mockStorage.get(k);
            }
          }
          return result;
        },
        set: async (items: Record<string, any>) => {
          for (const [k, v] of Object.entries(items)) {
            mockStorage.set(k, v);
          }
        },
        remove: async (keys: string[]) => {
          for (const k of keys) mockStorage.delete(k);
        },
        clear: async () => mockStorage.clear(),
        onChanged: {
          addListener: () => {},
          removeListener: () => {},
        },
      },
    },
  };
});

describe('privacyFlowStore resilience and data integrity', () => {
  beforeEach(async () => {
    mockStorage.clear();
    const { privacyFlowStore } = await import('@extension/storage');
    await privacyFlowStore.clear();
  });

  it('can add steps with complete data and computes total redactions', async () => {
    const { privacyFlowStore } = await import('@extension/storage');
    const stepId = await privacyFlowStore.addStep({
      stepNumber: 1,
      taskId: 'test-task-1',
      url: 'https://example.com',
      title: 'Example',
      sanitization: {
        sensitiveCount: 2,
        types: ['EMAIL', 'PHONE'],
        sources: ['dom', 'regex'],
        redactionsCount: 2,
        summary: '2 sensitive items redacted',
        sanitizedScreenshot: 'data:image/png;base64,sample',
        rawScreenshot: null,
      },
      outgoing: {
        modelName: 'gpt-4o',
        provider: 'openai',
        charCount: 150,
        sanitizedTextPreview: 'Preview text',
        hasScreenshot: true,
        dataKeysIncluded: [],
      },
    });

    expect(stepId).toBeDefined();
    const state = await privacyFlowStore.get();
    expect(state.steps.length).toBe(1);
    expect(state.totalRedactionsCount).toBe(2);
    expect(state.steps[0].stepNumber).toBe(1);
    expect(state.steps[0].sanitization.redactionsCount).toBe(2);
    expect(state.steps[0].sanitization.sanitizedScreenshot).toBe('data:image/png;base64,sample');
  });

  it('safely updates incoming abstract plan and local resolution', async () => {
    const { privacyFlowStore } = await import('@extension/storage');
    await privacyFlowStore.addStep({
      stepNumber: 1,
      taskId: 'task-inspect',
      url: 'https://example.com/checkout',
      title: 'Checkout',
      sanitization: {
        sensitiveCount: 1,
        types: ['CREDIT_CARD'],
        sources: ['dom'],
        redactionsCount: 1,
        summary: '1 redacted',
      },
      outgoing: {
        modelName: 'gpt-4o',
        provider: 'openai',
        charCount: 50,
        sanitizedTextPreview: 'Text',
        hasScreenshot: false,
        dataKeysIncluded: ['profile.cardNumber'],
      },
    });

    await privacyFlowStore.updateStepIncoming(
      1,
      {
        abstractPlanPreview: 'click(element 3)',
        dataKeysUsed: ['profile.cardNumber'],
      },
      'task-inspect',
    );

    await privacyFlowStore.updateStepResolution(
      1,
      {
        resolvedKeys: ['profile.cardNumber'],
        elementIndex: 3,
        sanitizedMessage: 'Card number populated securely',
        timestamp: Date.now(),
      },
      'task-inspect',
    );

    const latest = await privacyFlowStore.getLatest();
    expect(latest).toBeDefined();
    expect(latest?.incoming?.abstractPlanPreview).toBe('click(element 3)');
    expect(latest?.localResolution?.resolvedKeys).toContain('profile.cardNumber');
    expect(latest?.localResolution?.sanitizedMessage).toBe('Card number populated securely');
  });

  it('can clear storage cleanly', async () => {
    const { privacyFlowStore } = await import('@extension/storage');
    await privacyFlowStore.addStep({
      stepNumber: 1,
      taskId: 'task-to-clear',
      url: 'https://example.com',
      title: 'Title',
      sanitization: {
        sensitiveCount: 3,
        types: ['EMAIL'],
        sources: ['dom'],
        redactionsCount: 3,
        summary: '3 redacted',
      },
      outgoing: {
        modelName: 'gpt-4o',
        provider: 'openai',
        charCount: 50,
        sanitizedTextPreview: 'Text',
        hasScreenshot: false,
        dataKeysIncluded: [],
      },
    });

    await privacyFlowStore.clear();
    const state = await privacyFlowStore.get();
    expect(state.steps.length).toBe(0);
    expect(state.totalRedactionsCount).toBe(0);
  });
});
