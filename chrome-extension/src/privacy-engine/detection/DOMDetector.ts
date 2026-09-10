/**
 * privacy-engine/detection/DOMDetector.ts
 *
 * Detects sensitivity from DOM/form *semantics* rather than content: input type,
 * autocomplete tokens, name/id/aria-label/placeholder keywords. This is high
 * precision (a `type="password"` field IS a password field) and catches values
 * that regex can't (e.g. an empty password field, or a name field with no
 * recognisable pattern).
 *
 * The `type`/autocomplete-token logic is migrated from the original
 * `chrome-extension/src/redaction/domSanitizer.ts` (pre-existing project code);
 * the keyword/label heuristics for NAME/ADDRESS/AADHAAR/PAN/PASSPORT/etc. are new.
 */
import type { Detector, DetectorInput, DetectionSource, SensitiveDataType, SensitiveRegion, GenericDomNode } from '../core/types';

const SENSITIVE_AUTOCOMPLETE_TOKENS: Record<string, SensitiveDataType> = {
  'cc-number': 'CREDIT_CARD',
  'cc-csc': 'CREDIT_CARD',
  'cc-exp': 'CREDIT_CARD',
  'cc-exp-month': 'CREDIT_CARD',
  'cc-exp-year': 'CREDIT_CARD',
  'cc-type': 'CREDIT_CARD',
  email: 'EMAIL',
  tel: 'PHONE',
  'tel-national': 'PHONE',
  'current-password': 'PASSWORD',
  'new-password': 'PASSWORD',
  'one-time-code': 'OTP',
  name: 'NAME',
  'given-name': 'NAME',
  'family-name': 'NAME',
  'additional-name': 'NAME',
  'street-address': 'ADDRESS',
  'address-line1': 'ADDRESS',
  'address-line2': 'ADDRESS',
  'postal-code': 'ADDRESS',
};

const INPUT_TYPE_MAP: Record<string, SensitiveDataType> = {
  password: 'PASSWORD',
  email: 'EMAIL',
  tel: 'PHONE',
};

// Keyword -> type, matched (case-insensitively, whole-word-ish) against name/id/aria-label/placeholder.
const KEYWORD_RULES: Array<{ pattern: RegExp; type: SensitiveDataType }> = [
  { pattern: /aadhaar|aadhar|uidai/i, type: 'AADHAAR' },
  { pattern: /\bpan\b|pan[_-]?number|pan[_-]?card/i, type: 'PAN' },
  { pattern: /passport/i, type: 'PASSPORT' },
  { pattern: /ifsc/i, type: 'IFSC' },
  { pattern: /account[_-]?number|bank[_-]?account|acc[_-]?no/i, type: 'BANK_ACCOUNT' },
  { pattern: /credit[_-]?card|debit[_-]?card|card[_-]?number|cvv|cvc/i, type: 'CREDIT_CARD' },
  { pattern: /\botp\b|one[-_]?time[-_]?(?:passcode|password|code)/i, type: 'OTP' },
  { pattern: /\b(full[_-]?name|first[_-]?name|last[_-]?name|surname|given[_-]?name)\b/i, type: 'NAME' },
  { pattern: /address|street|city|pincode|postal/i, type: 'ADDRESS' },
  { pattern: /phone|mobile|contact[_-]?number/i, type: 'PHONE' },
  { pattern: /\bemail\b/i, type: 'EMAIL' },
];

const FIELD_LABEL_ATTRS = ['name', 'id', 'aria-label', 'placeholder'];

function detectFromField(node: GenericDomNode): SensitiveDataType | null {
  const type = node.attributes?.type?.toLowerCase();
  if (type && INPUT_TYPE_MAP[type]) {
    return INPUT_TYPE_MAP[type];
  }

  const autocomplete = node.attributes?.autocomplete?.toLowerCase();
  if (autocomplete) {
    for (const token of autocomplete.split(/\s+/)) {
      if (SENSITIVE_AUTOCOMPLETE_TOKENS[token]) {
        return SENSITIVE_AUTOCOMPLETE_TOKENS[token];
      }
    }
  }

  for (const attr of FIELD_LABEL_ATTRS) {
    const val = node.attributes?.[attr];
    if (!val) continue;
    for (const rule of KEYWORD_RULES) {
      if (rule.pattern.test(val)) {
        return rule.type;
      }
    }
  }

  return null;
}

function isFormField(node: GenericDomNode): boolean {
  const tag = (node.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

function walk(node: GenericDomNode, regions: SensitiveRegion[], source: DetectionSource, idSeed: { n: number }) {
  if (isFormField(node)) {
    const type = detectFromField(node);
    if (type) {
      // DOM field-semantics detection is high precision: a password input IS a
      // password field regardless of its current value.
      regions.push({
        id: `dom-${idSeed.n++}`,
        type,
        source,
        confidence: 0.95,
        action: 'REDACT',
        domNodeId: node.id,
        domField: 'attributes.value',
        bbox: node.bbox,
      });
    }
  }
  for (const child of node.children) {
    walk(child, regions, source, idSeed);
  }
}

export class DOMDetector implements Detector {
  readonly source: DetectionSource = 'dom';

  async detect(input: DetectorInput): Promise<SensitiveRegion[]> {
    if (!input.dom?.root) return [];
    const regions: SensitiveRegion[] = [];
    walk(input.dom.root, regions, this.source, { n: 0 });
    return regions;
  }
}
