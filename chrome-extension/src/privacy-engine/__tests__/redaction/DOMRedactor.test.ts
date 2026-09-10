import { describe, it, expect } from 'vitest';
import { DOMRedactor } from '../../redaction/DOMRedactor';
import type { DOMSnapshot, GenericDomNode, SensitiveRegion } from '../../core/types';

function makeSnapshot(): { snapshot: DOMSnapshot; input: GenericDomNode; text: GenericDomNode } {
  const text: GenericDomNode = { id: 't1', tagName: null, attributes: {}, isTextNode: true, text: 'admin@nanobrowser.ai', children: [] };
  const input: GenericDomNode = { id: 'e1', tagName: 'input', attributes: { type: 'password', value: 'hunter2', id: 'pwd' }, children: [] };
  const root: GenericDomNode = { id: 'root', tagName: 'div', attributes: {}, children: [input, text] };
  const nodesById = new Map<string, GenericDomNode>([
    ['root', root],
    ['e1', input],
    ['t1', text],
  ]);
  return { snapshot: { root, nodesById }, input, text };
}

describe('DOMRedactor', () => {
  it('replaces an attribute value with a semantic placeholder for REDACT', () => {
    const { snapshot, input } = makeSnapshot();
    const region: SensitiveRegion = {
      id: 'r1',
      type: 'PASSWORD',
      source: 'dom',
      confidence: 0.95,
      action: 'REDACT',
      domNodeId: 'e1',
      domField: 'attributes.value',
    };

    const count = new DOMRedactor().redact(snapshot, [region]);

    expect(count).toBe(1);
    expect(input.attributes.value).toBe('[PASSWORD_REDACTED]');
    expect(input.attributes.id).toBe('pwd'); // untouched
  });

  it('replaces text node content, preserving structure/highlight-relevant fields', () => {
    const { snapshot, text } = makeSnapshot();
    const region: SensitiveRegion = {
      id: 'r2',
      type: 'EMAIL',
      source: 'regex',
      confidence: 0.97,
      action: 'REDACT',
      domNodeId: 't1',
      domField: 'text',
    };

    new DOMRedactor().redact(snapshot, [region]);
    expect(text.text).toBe('[EMAIL_REDACTED]');
  });

  it('does not modify anything for ALLOW actions', () => {
    const { snapshot, input } = makeSnapshot();
    const region: SensitiveRegion = {
      id: 'r3',
      type: 'PASSWORD',
      source: 'dom',
      confidence: 0.95,
      action: 'ALLOW',
      domNodeId: 'e1',
      domField: 'attributes.value',
    };

    const count = new DOMRedactor().redact(snapshot, [region]);
    expect(count).toBe(0);
    expect(input.attributes.value).toBe('hunter2');
  });

  it('uses [REMOVED] for BLOCK and a MASKED placeholder for MASK', () => {
    const { snapshot, input, text } = makeSnapshot();
    new DOMRedactor().redact(snapshot, [
      { id: 'r4', type: 'PASSWORD', source: 'dom', confidence: 0.9, action: 'BLOCK', domNodeId: 'e1', domField: 'attributes.value' },
      { id: 'r5', type: 'EMAIL', source: 'regex', confidence: 0.9, action: 'MASK', domNodeId: 't1', domField: 'text' },
    ]);
    expect(input.attributes.value).toBe('[REMOVED]');
    expect(text.text).toBe('[EMAIL_MASKED]');
  });
});
