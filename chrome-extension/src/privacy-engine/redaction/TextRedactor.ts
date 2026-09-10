/**
 * privacy-engine/redaction/TextRedactor.ts
 *
 * Redacts flat, non-DOM text fields — url, title, other tabs' urls/titles,
 * and extraText (e.g. action results/extracted content) — the same way
 * DOMRedactor handles DOM nodes and ImageRedactor handles screenshots.
 *
 * These fields have no DOM node to write back onto, so redaction re-runs the
 * SAME shared regex pattern (from `detection/patterns.ts`) that flagged the
 * region and replaces every match of that type with a semantic placeholder.
 * This guarantees detection and redaction can't drift apart: whatever
 * `RegexDetector` used to find a match is exactly what `TextRedactor` uses to
 * remove it.
 */
import type { RedactionAction, SensitiveDataType, SensitiveRegion } from '../core/types';
import { PATTERNS, freshGlobalRegex } from '../detection/patterns';

const PATTERN_BY_TYPE = new Map(PATTERNS.map(p => [p.type, p.regex]));

function placeholderFor(type: SensitiveDataType, action: RedactionAction): string {
  if (action === 'BLOCK') return '[REMOVED]';
  if (action === 'MASK') return `[${type}_MASKED]`;
  return `[${type}_REDACTED]`;
}

export class TextRedactor {
  /**
   * `fields`: fieldId -> raw text. `regions`: the final, fused, policy-actioned
   * regions whose `textField` matches one of these fieldIds. Returns a NEW
   * map with the same keys, redacted text. Fields with no matching region (or
   * only ALLOW-actioned regions) are returned unchanged.
   */
  redact(fields: Record<string, string>, regions: SensitiveRegion[]): { redacted: Record<string, string>; redactedCount: number } {
    const byField = new Map<string, SensitiveRegion[]>();
    for (const r of regions) {
      if (!r.textField) continue;
      const arr = byField.get(r.textField) ?? [];
      arr.push(r);
      byField.set(r.textField, arr);
    }

    const redacted: Record<string, string> = {};
    let redactedCount = 0;

    for (const [fieldId, text] of Object.entries(fields)) {
      const fieldRegions = byField.get(fieldId);
      if (!fieldRegions || fieldRegions.length === 0) {
        redacted[fieldId] = text;
        continue;
      }

      let result = text;
      for (const region of fieldRegions) {
        if (region.action === 'ALLOW') continue;
        const basePattern = PATTERN_BY_TYPE.get(region.type);
        if (!basePattern) continue; // e.g. a vision/DOM-only type that shouldn't appear on a textField region
        const regex = freshGlobalRegex(basePattern);
        const placeholder = placeholderFor(region.type, region.action);
        const before = result;
        result = result.replace(regex, placeholder);
        if (result !== before) redactedCount++;
      }
      redacted[fieldId] = result;
    }

    return { redacted, redactedCount };
  }
}
