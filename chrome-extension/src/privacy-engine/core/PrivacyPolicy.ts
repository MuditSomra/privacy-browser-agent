/**
 * privacy-engine/core/PrivacyPolicy.ts
 *
 * Configurable mapping of SensitiveDataType -> RedactionAction, so behaviour
 * isn't hard-coded across detectors/redactors (Part 7). A caller (e.g. a
 * hackathon demo settings page) can override this per-instance.
 */
import type { RedactionAction, SensitiveDataType } from './types';

export type PrivacyPolicyMap = Record<SensitiveDataType, RedactionAction>;

/**
 * Sensible defaults. UNKNOWN_SENSITIVE defaults to BLOCK-leaning REDACT rather
 * than ALLOW, per the "fail closed on the unknown case" principle in Part 6/7.
 */
export const DEFAULT_PRIVACY_POLICY: PrivacyPolicyMap = {
  PASSWORD: 'REDACT',
  EMAIL: 'REDACT',
  PHONE: 'REDACT',
  NAME: 'REDACT',
  ADDRESS: 'REDACT',
  AADHAAR: 'REDACT',
  PAN: 'REDACT',
  PASSPORT: 'REDACT',
  CREDIT_CARD: 'REDACT',
  DEBIT_CARD: 'REDACT',
  BANK_ACCOUNT: 'REDACT',
  IFSC: 'REDACT',
  API_KEY_OR_SECRET: 'REDACT',
  OTP: 'REDACT',
  FACE: 'BLUR',
  PERSON: 'BLUR',
  DOCUMENT: 'BLUR',
  UNKNOWN_SENSITIVE: 'REDACT',
};

export class PrivacyPolicy {
  private policy: PrivacyPolicyMap;

  constructor(overrides?: Partial<PrivacyPolicyMap>) {
    this.policy = { ...DEFAULT_PRIVACY_POLICY, ...(overrides ?? {}) };
  }

  actionFor(type: SensitiveDataType): RedactionAction {
    return this.policy[type] ?? 'REDACT';
  }

  set(type: SensitiveDataType, action: RedactionAction): void {
    this.policy[type] = action;
  }

  snapshot(): PrivacyPolicyMap {
    return { ...this.policy };
  }
}
