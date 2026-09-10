/**
 * privacy-engine/detection/patterns.ts
 *
 * Single source of truth for the structured/regex PII patterns, shared by
 * `RegexDetector` (presence detection, DOM + flat text) and `TextRedactor`
 * (actual in-place string redaction of flat text fields like url/title).
 * Keeping one shared list means a pattern can never be "detected" without
 * also being redactable, or vice versa.
 *
 * The email/phone/credit-card patterns are migrated from the original
 * `chrome-extension/src/redaction/domSanitizer.ts` (pre-existing project
 * code); PAN/Aadhaar/passport/IFSC/bank-account/API-key/OTP are new.
 */
import type { SensitiveDataType } from '../core/types';

export const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export const PHONE_REGEX = /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;

export const CREDIT_CARD_REGEX = /\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{4}[-\s]\d{6}[-\s]\d{5}\b/g;

// Indian Permanent Account Number: 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F)
export const PAN_REGEX = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g;

// Indian Aadhaar: 12 digits, conventionally grouped in 4s. Word-boundary'd digit run,
// deliberately NOT matching runs that are part of a longer digit string.
export const AADHAAR_REGEX = /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g;

// Indian passport: 1 letter (not part of a few reserved letters) followed by 7 digits.
export const PASSPORT_REGEX = /\b[A-PR-WYa-pr-wy][0-9]{7}\b/g;

// Indian bank IFSC code: 4 letters, literal 0, 6 alphanumeric (e.g. HDFC0001234)
export const IFSC_REGEX = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;

// Bare 9-18 digit run that isn't already caught by the above (used only as a
// low-confidence signal for "looks like a bank account number").
export const BANK_ACCOUNT_REGEX = /\b\d{9,18}\b/g;

// Common API key/secret prefixes seen in the wild.
export const API_KEY_REGEX = /\b(?:sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

// One-time codes: "OTP is 482913" style, standalone 4-8 digit codes near the word OTP/code.
export const OTP_CONTEXT_REGEX = /\b(?:otp|one[- ]?time[- ]?(?:passcode|password|code))\D{0,10}(\d{4,8})\b/gi;

export interface PatternDef {
  type: SensitiveDataType;
  regex: RegExp;
  confidence: number;
}

// Order matters: more specific patterns first, since fusion/redaction later
// dedupe/replace overlapping spans and earlier matches "claim" their text first.
export const PATTERNS: PatternDef[] = [
  { type: 'EMAIL', regex: EMAIL_REGEX, confidence: 0.97 },
  { type: 'PAN', regex: PAN_REGEX, confidence: 0.9 },
  { type: 'IFSC', regex: IFSC_REGEX, confidence: 0.9 },
  { type: 'PASSPORT', regex: PASSPORT_REGEX, confidence: 0.55 }, // ambiguous vs. other alnum ids
  { type: 'API_KEY_OR_SECRET', regex: API_KEY_REGEX, confidence: 0.85 },
  { type: 'CREDIT_CARD', regex: CREDIT_CARD_REGEX, confidence: 0.75 },
  { type: 'AADHAAR', regex: AADHAAR_REGEX, confidence: 0.5 }, // easily confused with phone/other 12-digit runs
  { type: 'PHONE', regex: PHONE_REGEX, confidence: 0.8 },
  { type: 'BANK_ACCOUNT', regex: BANK_ACCOUNT_REGEX, confidence: 0.35 }, // very weak alone
];

/** Fresh copy of a pattern's regex with the global flag guaranteed, safe for repeated .replace()/.exec() use. */
export function freshGlobalRegex(regex: RegExp): RegExp {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  return new RegExp(regex.source, flags);
}
