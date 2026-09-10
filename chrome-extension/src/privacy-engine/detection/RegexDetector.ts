/**
 * privacy-engine/detection/RegexDetector.ts
 *
 * Structured/regex PII detection over two kinds of input:
 *  - DOM trees (text nodes + a fixed set of attributes)
 *  - flat named text fields (url, title, tab urls/titles, extraText/action
 *    results) — anything that isn't part of the DOM but is still headed for
 *    the network must be scanned the same way.
 *
 * Regex-based detection is inherently heuristic: these patterns will produce
 * some false positives/negatives. We keep confidence values honest (not all
 * 1.0) and let DetectionFusion combine them with DOM-field context where
 * available. Patterns live in `./patterns.ts`, shared with `TextRedactor` so
 * detection and redaction can never drift apart.
 */
import type { Detector, DetectorInput, DetectionSource, SensitiveDataType, SensitiveRegion, GenericDomNode } from '../core/types';
import { PATTERNS } from './patterns';

/** Runs all patterns against a single string, returning (type, confidence) matches. Value itself is discarded. */
function scanString(text: string): Array<{ type: SensitiveDataType; confidence: number }> {
  if (!text) return [];
  const hits: Array<{ type: SensitiveDataType; confidence: number }> = [];
  for (const { type, regex, confidence } of PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) {
      hits.push({ type, confidence });
    }
  }
  return hits;
}

const SCANNABLE_ATTRS = ['placeholder', 'aria-label', 'title', 'value', 'alt', 'data-tooltip', 'href', 'name'];

function walkDom(node: GenericDomNode, regions: SensitiveRegion[], source: DetectionSource, idSeed: { n: number }) {
  if (node.isTextNode && node.text) {
    for (const hit of scanString(node.text)) {
      regions.push({
        id: `regex-${idSeed.n++}`,
        type: hit.type,
        source,
        confidence: hit.confidence,
        action: 'REDACT',
        domNodeId: node.id,
        domField: 'text',
        bbox: node.bbox,
      });
    }
  }
  for (const attr of SCANNABLE_ATTRS) {
    const val = node.attributes?.[attr];
    if (val) {
      for (const hit of scanString(val)) {
        regions.push({
          id: `regex-${idSeed.n++}`,
          type: hit.type,
          source,
          confidence: hit.confidence,
          action: 'REDACT',
          domNodeId: node.id,
          domField: `attributes.${attr}`,
          bbox: node.bbox,
        });
      }
    }
  }
  for (const child of node.children) {
    walkDom(child, regions, source, idSeed);
  }
}

export class RegexDetector implements Detector {
  readonly source: DetectionSource = 'regex';

  async detect(input: DetectorInput): Promise<SensitiveRegion[]> {
    const regions: SensitiveRegion[] = [];
    const idSeed = { n: 0 };

    if (input.dom?.root) {
      walkDom(input.dom.root, regions, this.source, idSeed);
    }

    if (input.textFields) {
      for (const [fieldId, text] of Object.entries(input.textFields)) {
        for (const hit of scanString(text)) {
          regions.push({
            id: `regex-${idSeed.n++}`,
            type: hit.type,
            source: this.source,
            confidence: hit.confidence,
            action: 'REDACT',
            textField: fieldId,
          });
        }
      }
    }

    return regions;
  }
}
