import { describe, it, expect } from 'vitest';
import { DOMDetector } from '../../detection/DOMDetector';
import type { DOMSnapshot, GenericDomNode } from '../../core/types';

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

describe('DOMDetector', () => {
  it('flags a type="password" input regardless of its value', async () => {
    const node = elementNode('e1', 'input', { type: 'password', id: 'pwd' });
    const detector = new DOMDetector();
    const regions = await detector.detect({ dom: snapshot(node) });
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ type: 'PASSWORD', domNodeId: 'e1', confidence: 0.95 });
  });

  it('flags autocomplete="cc-number" fields', async () => {
    const node = elementNode('e1', 'input', { type: 'text', autocomplete: 'cc-number' });
    const detector = new DOMDetector();
    const regions = await detector.detect({ dom: snapshot(node) });
    expect(regions[0].type).toBe('CREDIT_CARD');
  });

  it('flags Aadhaar-labelled fields via keyword match on name/aria-label', async () => {
    const node = elementNode('e1', 'input', { type: 'text', name: 'aadhaar_number', 'aria-label': 'Aadhaar Number' });
    const detector = new DOMDetector();
    const regions = await detector.detect({ dom: snapshot(node) });
    expect(regions[0].type).toBe('AADHAAR');
  });

  it('flags passport-labelled fields', async () => {
    const node = elementNode('e1', 'input', { type: 'text', placeholder: 'Enter your passport number' });
    const detector = new DOMDetector();
    const regions = await detector.detect({ dom: snapshot(node) });
    expect(regions[0].type).toBe('PASSPORT');
  });

  it('does not flag a plain, unlabelled text input', async () => {
    const node = elementNode('e1', 'input', { type: 'text', name: 'search_query' });
    const detector = new DOMDetector();
    const regions = await detector.detect({ dom: snapshot(node) });
    expect(regions).toEqual([]);
  });

  it('recurses into children and finds fields at any depth', async () => {
    const inner = elementNode('e2', 'input', { type: 'email' });
    const root = elementNode('e1', 'form', {}, [elementNode('wrap', 'div', {}, [inner])]);
    const detector = new DOMDetector();
    const regions = await detector.detect({ dom: snapshot(root) });
    expect(regions.some(r => r.domNodeId === 'e2' && r.type === 'EMAIL')).toBe(true);
  });
});
