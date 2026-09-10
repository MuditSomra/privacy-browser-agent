import { describe, it, expect } from 'vitest';
import { PrivacyEngine } from '../core/PrivacyEngine';
import { PrivacyPolicy } from '../core/PrivacyPolicy';
import type { ImageRedactor } from '../redaction/ImageRedactor';
import type { DOMSnapshot, GenericDomNode, PageContext, Detector, SensitiveRegion } from '../core/types';

function elementNode(id: string, tagName: string, attributes: Record<string, string>, children: GenericDomNode[] = []): GenericDomNode {
  return { id, tagName, attributes, children };
}

function textNode(id: string, text: string): GenericDomNode {
  return { id, tagName: null, attributes: {}, isTextNode: true, text, children: [] };
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

function throwingDetector(message: string): Detector {
  return {
    source: 'vision',
    detect: async () => {
      throw new Error(message);
    },
  };
}

function stubDetector(source: Detector['source'], regions: SensitiveRegion[]): Detector {
  return { source, detect: async () => regions };
}

describe('PrivacyEngine - happy path', () => {
  it('redacts a password field and an email found by regex, end to end', async () => {
    const passwordField = elementNode('e1', 'input', { type: 'password', value: 'hunter2' });
    const emailText = textNode('t1', 'Reach me at jane.doe@example.com');
    const root = elementNode('root', 'form', {}, [passwordField, emailText]);

    const pageContext: PageContext = { url: 'https://example.com', dom: snapshot(root) };
    const engine = new PrivacyEngine({ requireVisionForScreenshots: true });

    const result = await engine.sanitize(pageContext);

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(passwordField.attributes.value).toBe('[PASSWORD_REDACTED]');
    expect(emailText.text).toBe('[EMAIL_REDACTED]');
    expect(result.context.privacyMetadata.analysisComplete).toBe(true);
    expect(result.context.privacyMetadata.detectedCount).toBeGreaterThanOrEqual(2);
  });

  it('leaves non-sensitive content untouched', async () => {
    const button = elementNode('e1', 'button', { type: 'submit' }, [textNode('t1', 'Add to cart — $49.99')]);
    const pageContext: PageContext = { dom: snapshot(button) };
    const engine = new PrivacyEngine();

    const result = await engine.sanitize(pageContext);
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.context.sensitiveRegions).toEqual([]);
  });

  it('applies a custom PrivacyPolicy override (e.g. downgrading EMAIL to ALLOW)', async () => {
    const emailField = elementNode('e1', 'input', { type: 'email', value: 'jane@example.com' });
    const pageContext: PageContext = { dom: snapshot(emailField) };
    const policy = new PrivacyPolicy({ EMAIL: 'ALLOW' });
    const engine = new PrivacyEngine({ policy });

    const result = await engine.sanitize(pageContext);
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    // ALLOW means the redactor skips it entirely.
    expect(emailField.attributes.value).toBe('jane@example.com');
  });

  it('redacts url/title/tabs/extraText, not just the DOM (Phase-1 audit fix)', async () => {
    const pageContext: PageContext = {
      url: 'https://example.com/callback?email=leaked@example.com',
      title: 'Account for leaked@example.com',
      tabs: [{ id: 2, url: 'https://x.com', title: 'Contact: leaked2@example.com' }],
      extraText: [{ id: 'actionResult:0:content', text: 'Extracted email: extracted@example.com' }],
    };
    const engine = new PrivacyEngine();

    const result = await engine.sanitize(pageContext);
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;

    expect(result.context.url).not.toContain('leaked@example.com');
    expect(result.context.url).toContain('EMAIL_REDACTED');
    expect(result.context.title).not.toContain('leaked@example.com');
    expect(result.context.tabs?.[0].title).not.toContain('leaked2@example.com');
    expect(result.context.sanitizedExtraText?.[0].text).not.toContain('extracted@example.com');
    expect(result.context.sanitizedExtraText?.[0].id).toBe('actionResult:0:content');
  });

  it('correlates a DOM-anchored sensitive region with a known bbox to ALSO redact the screenshot (coordinate-based, not OCR)', async () => {
    // Simulates a future host DOM extraction that populates GenericDomNode.bbox
    // (see docs/screenshot-text-pii.md) — the engine-side handling of it is
    // real and tested here even though NanoBrowser doesn't populate it yet.
    const passwordField: GenericDomNode = {
      id: 'e1',
      tagName: 'input',
      attributes: { type: 'password', value: 'hunter2' },
      bbox: { xmin: 10, ymin: 20, xmax: 110, ymax: 40 },
      children: [],
    };
    const pageContext: PageContext = { dom: snapshot(passwordField), screenshot: 'raw_base64_data' };

    let redactedBoxes: unknown = null;
    const spyImageRedactor = {
      redact: async (_img: string, boxes: unknown) => {
        redactedBoxes = boxes;
        return 'redacted_base64_data';
      },
    };
    const engine = new PrivacyEngine({
      visionDetector: stubDetector('vision', []), // no separate vision hit needed
      imageRedactor: spyImageRedactor as unknown as InstanceType<typeof ImageRedactor>,
    });

    const result = await engine.sanitize(pageContext);
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(redactedBoxes).toEqual([{ xmin: 10, ymin: 20, xmax: 110, ymax: 40 }]);
    expect(result.context.sanitizedScreenshot).toBe('redacted_base64_data');
  });
});

describe('PrivacyEngine - fail closed (Part 6)', () => {
  it('does not return sanitized context when DOM detection throws', async () => {
    const failingDom: Detector = { source: 'dom', detect: async () => { throw new Error('dom crashed'); } };
    const engine = new PrivacyEngine({ domDetector: failingDom });

    const result = await engine.sanitize({ dom: snapshot(elementNode('e1', 'div', {})) });

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toContain('DOM detection failed');
  });

  it('does not return sanitized context (or the raw screenshot) when vision analysis of a screenshot fails', async () => {
    const engine = new PrivacyEngine({ visionDetector: throwingDetector('model not loaded') });

    const result = await engine.sanitize({ screenshot: 'raw_base64_data' });

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toContain('Vision analysis');
    // Critically: nothing resembling the raw screenshot should be anywhere on the result.
    expect(JSON.stringify(result)).not.toContain('raw_base64_data');
  });

  it('allows a screenshot-free request through even if the vision detector would fail (never called)', async () => {
    const engine = new PrivacyEngine({ visionDetector: throwingDetector('should not be invoked') });
    const result = await engine.sanitize({ dom: snapshot(elementNode('e1', 'div', {})) });
    expect(result.allowed).toBe(true);
  });

  it('can be configured to continue without vision (requireVisionForScreenshots=false) for text-only agents', async () => {
    const engine = new PrivacyEngine({
      visionDetector: throwingDetector('no vision available'),
      requireVisionForScreenshots: false,
    });
    const result = await engine.sanitize({ screenshot: 'raw_base64_data' });
    expect(result.allowed).toBe(true);
  });

  it('fails closed if the image redactor cannot redact a detected sensitive region', async () => {
    // No custom vision detector installed and no real model in the test env ->
    // VisionDetector itself will throw first. This test exercises the case where
    // vision succeeds but the redactor (canvas) is unavailable, by injecting a
    // vision stub that finds a face and relying on the real ImageRedactor.
    const visionStub = stubDetector('vision', [
      { id: 'v1', type: 'FACE', source: 'vision', confidence: 0.9, action: 'BLUR', bbox: { xmin: 0, ymin: 0, xmax: 10, ymax: 10 } },
    ]);
    const engine = new PrivacyEngine({ visionDetector: visionStub });

    const result = await engine.sanitize({ screenshot: 'raw_base64_data' });

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reason).toContain('Redaction failed');
  });
});
