import { describe, it, expect } from 'vitest';
import { TextRedactor } from '../../redaction/TextRedactor';
import type { SensitiveRegion } from '../../core/types';

describe('TextRedactor', () => {
  it('redacts a matched email within a field, replacing only the matched substring', () => {
    const fields = { url: 'https://example.com/cb?email=leaked@example.com&ok=1' };
    const regions: SensitiveRegion[] = [
      { id: 'r1', type: 'EMAIL', source: 'regex', confidence: 0.97, action: 'REDACT', textField: 'url' },
    ];

    const { redacted, redactedCount } = new TextRedactor().redact(fields, regions);

    expect(redacted.url).toBe('https://example.com/cb?email=[EMAIL_REDACTED]&ok=1');
    expect(redactedCount).toBe(1);
  });

  it('leaves fields with no matching region untouched', () => {
    const fields = { title: 'Just a normal page title', url: 'https://example.com' };
    const regions: SensitiveRegion[] = [{ id: 'r1', type: 'EMAIL', source: 'regex', confidence: 0.9, action: 'REDACT', textField: 'url' }];

    const { redacted } = new TextRedactor().redact(fields, regions);
    expect(redacted.title).toBe('Just a normal page title');
  });

  it('respects ALLOW: does not touch the field even if a region was detected there', () => {
    const fields = { title: 'Contact: allowed@example.com' };
    const regions: SensitiveRegion[] = [{ id: 'r1', type: 'EMAIL', source: 'regex', confidence: 0.9, action: 'ALLOW', textField: 'title' }];

    const { redacted, redactedCount } = new TextRedactor().redact(fields, regions);
    expect(redacted.title).toBe('Contact: allowed@example.com');
    expect(redactedCount).toBe(0);
  });

  it('redacts multiple distinct fields independently', () => {
    const fields = {
      url: 'https://example.com?e=a@example.com',
      title: 'Reach b@example.com for support',
    };
    const regions: SensitiveRegion[] = [
      { id: 'r1', type: 'EMAIL', source: 'regex', confidence: 0.9, action: 'REDACT', textField: 'url' },
      { id: 'r2', type: 'EMAIL', source: 'regex', confidence: 0.9, action: 'REDACT', textField: 'title' },
    ];

    const { redacted } = new TextRedactor().redact(fields, regions);
    expect(redacted.url).not.toContain('a@example.com');
    expect(redacted.title).not.toContain('b@example.com');
  });

  it('uses MASK/BLOCK placeholders per the region action', () => {
    const fields = { note: 'PAN: ABCDE1234F' };
    const regions: SensitiveRegion[] = [{ id: 'r1', type: 'PAN', source: 'regex', confidence: 0.9, action: 'MASK', textField: 'note' }];
    const { redacted } = new TextRedactor().redact(fields, regions);
    expect(redacted.note).toBe('PAN: [PAN_MASKED]');
  });
});
