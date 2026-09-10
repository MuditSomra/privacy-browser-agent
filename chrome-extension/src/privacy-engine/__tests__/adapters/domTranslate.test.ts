import { describe, it, expect } from 'vitest';
import { DOMElementNode, DOMTextNode } from '@src/background/browser/dom/views';
import { toGenericDomSnapshot } from '../../adapters/nanobrowser/domTranslate';
import { DOMRedactor } from '../../redaction/DOMRedactor';
import type { SensitiveRegion } from '../../core/types';

function buildRealTree() {
  const passwordInput = new DOMElementNode({
    tagName: 'input',
    xpath: '//input[1]',
    attributes: { type: 'password', value: 'hunter2', id: 'pwd' },
    children: [],
    isVisible: true,
    highlightIndex: 0,
  });

  const emailText = new DOMTextNode('Contact: jane.doe@example.com', true);

  const wrapper = new DOMElementNode({
    tagName: 'div',
    xpath: '//div[1]',
    attributes: {},
    children: [passwordInput, emailText],
    isVisible: true,
  });

  return { wrapper, passwordInput, emailText };
}

describe('domTranslate - NanoBrowser <-> generic tree', () => {
  it('mirrors tagName/attributes/children onto the generic tree', () => {
    const { wrapper } = buildRealTree();
    const snapshot = toGenericDomSnapshot(wrapper);

    expect(snapshot.root.tagName).toBe('div');
    expect(snapshot.root.children).toHaveLength(2);
    expect(snapshot.root.children[0].tagName).toBe('input');
    expect(snapshot.root.children[0].attributes.type).toBe('password');
    expect(snapshot.root.children[1].isTextNode).toBe(true);
    expect(snapshot.root.children[1].text).toBe('Contact: jane.doe@example.com');
  });

  it('writes DOM attribute redactions back onto the ORIGINAL DOMElementNode (shared reference)', () => {
    const { wrapper, passwordInput } = buildRealTree();
    const snapshot = toGenericDomSnapshot(wrapper);
    const genericInput = snapshot.root.children[0];

    const region: SensitiveRegion = {
      id: 'r1',
      type: 'PASSWORD',
      source: 'dom',
      confidence: 0.95,
      action: 'REDACT',
      domNodeId: genericInput.id,
      domField: 'attributes.value',
    };
    new DOMRedactor().redact(snapshot, [region]);

    // The ORIGINAL NanoBrowser node's attributes object was mutated directly.
    expect(passwordInput.attributes.value).toBe('[PASSWORD_REDACTED]');
  });

  it('writes text redactions back onto the ORIGINAL DOMTextNode via the accessor proxy', () => {
    const { wrapper, emailText } = buildRealTree();
    const snapshot = toGenericDomSnapshot(wrapper);
    const genericText = snapshot.root.children[1];

    const region: SensitiveRegion = {
      id: 'r2',
      type: 'EMAIL',
      source: 'regex',
      confidence: 0.97,
      action: 'REDACT',
      domNodeId: genericText.id,
      domField: 'text',
    };
    new DOMRedactor().redact(snapshot, [region]);

    expect(emailText.text).toBe('[EMAIL_REDACTED]');
  });

  it("original tree's own clickableElementsToString reflects the redaction afterwards", () => {
    const { wrapper } = buildRealTree();
    const snapshot = toGenericDomSnapshot(wrapper);
    const genericInput = snapshot.root.children[0];

    new DOMRedactor().redact(snapshot, [
      { id: 'r1', type: 'PASSWORD', source: 'dom', confidence: 0.95, action: 'REDACT', domNodeId: genericInput.id, domField: 'attributes.value' },
    ]);

    const rendered = wrapper.clickableElementsToString(['value', 'type', 'id']);
    // NOTE: NanoBrowser's own clickableElementsToString caps individual
    // attribute values to 15 characters (pre-existing behavior, see
    // capTextLength in background/browser/dom/views.ts), so our 20-character
    // placeholder shows up truncated as "[PASSWORD_REDAC...". That's still
    // safe — no original content survives — it just means very long semantic
    // labels aren't fully visible to the model, only their prefix.
    expect(rendered).toContain('[PASSWORD_REDAC');
    expect(rendered).not.toContain('hunter2');
  });
});
