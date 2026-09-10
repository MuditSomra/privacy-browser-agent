/**
 * privacy-engine/redaction/DOMRedactor.ts
 *
 * Applies semantic redaction (Part 8) to a DOMSnapshot in place, given a list
 * of already-fused SensitiveRegion entries. "Semantic" means we replace the
 * value with a typed placeholder like [EMAIL_REDACTED] rather than a generic
 * black box, so the remote LLM still understands the *shape* of the page
 * (there IS an email field here) without ever seeing the value.
 *
 * MASK differs from REDACT by preserving partial structure (e.g. an asterisked
 * length hint) — kept intentionally conservative here (no length/format leakage)
 * since over-eager masking can itself leak information (e.g. digit count of a
 * card number). BLOCK removes the field's value/text entirely with no label.
 */
import type { DOMSnapshot, RedactionAction, SensitiveRegion } from '../core/types';

function placeholderFor(region: SensitiveRegion, action: RedactionAction): string {
  if (action === 'BLOCK') return '[REMOVED]';
  if (action === 'MASK') return `[${region.type}_MASKED]`;
  // REDACT and BLUR (BLUR only applies to vision regions, not DOM fields) both
  // resolve to the same semantic DOM placeholder.
  return `[${region.type}_REDACTED]`;
}

function setDomField(snapshot: DOMSnapshot, region: SensitiveRegion): boolean {
  if (!region.domNodeId || !region.domField) return false;
  const node = snapshot.nodesById.get(region.domNodeId);
  if (!node) return false;

  const placeholder = placeholderFor(region, region.action);

  if (region.domField === 'text') {
    node.text = placeholder;
    return true;
  }
  if (region.domField.startsWith('attributes.')) {
    const attr = region.domField.slice('attributes.'.length);
    if (node.attributes[attr] !== undefined) {
      node.attributes[attr] = placeholder;
    }
    return true;
  }
  return false;
}

export class DOMRedactor {
  /** Mutates `snapshot` in place, applying every region with action !== 'ALLOW'. Returns count actually redacted. */
  redact(snapshot: DOMSnapshot, regions: SensitiveRegion[]): number {
    let redacted = 0;
    for (const region of regions) {
      if (region.action === 'ALLOW') continue;
      if (setDomField(snapshot, region)) {
        redacted++;
      }
    }
    return redacted;
  }
}
