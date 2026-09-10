import { describe, it, expect } from 'vitest';
import { RegexDetector } from '../../detection/RegexDetector';
import type { DOMSnapshot, GenericDomNode } from '../../core/types';

function textNode(id: string, text: string): GenericDomNode {
  return { id, tagName: null, attributes: {}, isTextNode: true, text, children: [] };
}

function elementNode(id: string, tagName: string, attributes: Record<string, string>, children: GenericDomNode[] = []): GenericDomNode {
  return { id, tagName, attributes, children };
}

function snapshot(root: GenericDomNode): DOMSnapshot {
  const nodesById = new Map<string, GenericDomNode>();
  const walk = (n: GenericDomNode) => {
    nodesById.set(n.id, n);
    n.children.forEach(walk);
  };
  walk(root);
  return { root, nodesById };
}

describe('RegexDetector - flat text fields', () => {
  it('detects an email address in a named text field', async () => {
    const detector = new RegexDetector();
    const regions = await detector.detect({ textFields: { note: 'Contact us at support@example.com for help.' } });
    expect(regions.some(r => r.type === 'EMAIL')).toBe(true);
  });

  it('anchors flat-text detections to the field id, not a DOM node', async () => {
    const detector = new RegexDetector();
    const regions = await detector.detect({ textFields: { url: 'https://example.com?email=leak@example.com' } });
    const region = regions.find(r => r.type === 'EMAIL');
    expect(region?.textField).toBe('url');
    expect(region?.domNodeId).toBeUndefined();
  });

  it('detects a phone number in a named text field', async () => {
    const detector = new RegexDetector();
    const regions = await detector.detect({ textFields: { note: 'Call our hotline at 555-987-6543 today.' } });
    expect(regions.some(r => r.type === 'PHONE')).toBe(true);
  });

  it('detects a 16-digit credit card pattern', async () => {
    const detector = new RegexDetector();
    const regions = await detector.detect({ textFields: { note: 'Card charged: 4111-2222-3333-4444 (VISA).' } });
    expect(regions.some(r => r.type === 'CREDIT_CARD')).toBe(true);
  });

  it('detects an Indian PAN number', async () => {
    const detector = new RegexDetector();
    const regions = await detector.detect({ textFields: { note: 'PAN: ABCDE1234F' } });
    expect(regions.some(r => r.type === 'PAN')).toBe(true);
  });

  it('detects an IFSC code', async () => {
    const detector = new RegexDetector();
    const regions = await detector.detect({ textFields: { note: 'IFSC: HDFC0001234' } });
    expect(regions.some(r => r.type === 'IFSC')).toBe(true);
  });

  it('detects a likely API key/secret', async () => {
    const detector = new RegexDetector();
    const regions = await detector.detect({ textFields: { note: 'token=sk-abcdefghijklmnopqrstuvwx' } });
    expect(regions.some(r => r.type === 'API_KEY_OR_SECRET')).toBe(true);
  });

  it('returns nothing for benign text', async () => {
    const detector = new RegexDetector();
    const regions = await detector.detect({ textFields: { note: 'Buy our wireless headphones for $49.99' } });
    expect(regions).toEqual([]);
  });
});

describe('RegexDetector - DOM tree', () => {
  it('flags PII found in placeholder/aria-label attributes and anchors it to the node', async () => {
    const input = elementNode('e1', 'input', {
      type: 'text',
      placeholder: 'Search for john.doe@email.com',
      'aria-label': 'Contact +1 800-555-0199 for assistance',
    });
    const dom = snapshot(input);

    const detector = new RegexDetector();
    const regions = await detector.detect({ dom });

    const emailRegion = regions.find(r => r.type === 'EMAIL');
    expect(emailRegion).toBeDefined();
    expect(emailRegion?.domNodeId).toBe('e1');
    expect(emailRegion?.domField).toBe('attributes.placeholder');
  });

  it('flags PII inside text nodes', async () => {
    const child = textNode('t1', 'User email: admin@nanobrowser.ai, phone: 212-555-1234');
    const root = elementNode('e1', 'div', {}, [child]);
    const dom = snapshot(root);

    const detector = new RegexDetector();
    const regions = await detector.detect({ dom });

    expect(regions.some(r => r.domNodeId === 't1' && r.domField === 'text' && r.type === 'EMAIL')).toBe(true);
    expect(regions.some(r => r.domNodeId === 't1' && r.domField === 'text' && r.type === 'PHONE')).toBe(true);
  });
});
