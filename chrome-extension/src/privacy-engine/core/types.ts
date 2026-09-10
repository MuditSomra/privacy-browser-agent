/**
 * privacy-engine/core/types.ts
 *
 * Generic, agent-agnostic type contracts for the privacy engine.
 *
 * IMPORTANT: nothing in `privacy-engine/core`, `privacy-engine/detection`,
 * `privacy-engine/redaction`, or `privacy-engine/fusion` may import from
 * NanoBrowser (`@src/background/*`). Only files under `privacy-engine/adapters/*`
 * are allowed to know about a specific host agent.
 *
 * This is our team's original contribution for the SIH problem statement.
 * It does not claim any upstream NanoBrowser functionality as original work;
 * NanoBrowser-specific glue lives exclusively in `privacy-engine/adapters/nanobrowser`.
 */

/** Categories of sensitive data the engine can recognise. Extend as needed. */
export type SensitiveDataType =
  | 'PASSWORD'
  | 'EMAIL'
  | 'PHONE'
  | 'NAME'
  | 'ADDRESS'
  | 'AADHAAR'
  | 'PAN'
  | 'PASSPORT'
  | 'CREDIT_CARD'
  | 'DEBIT_CARD'
  | 'BANK_ACCOUNT'
  | 'IFSC'
  | 'API_KEY_OR_SECRET'
  | 'OTP'
  | 'FACE'
  | 'PERSON'
  | 'DOCUMENT'
  | 'UNKNOWN_SENSITIVE';

/** What the policy/redactor should do with a detected region. */
export type RedactionAction = 'ALLOW' | 'REDACT' | 'BLUR' | 'MASK' | 'BLOCK';

/** Where a detection came from — kept for fusion + audit/evaluation purposes. */
export type DetectionSource = 'dom' | 'regex' | 'ner' | 'vision';

export interface BoundingBox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

/**
 * A minimal, host-agnostic representation of one DOM-ish element.
 * A NanoBrowser adapter maps its own DOMElementNode/DOMTextNode tree into this
 * shape (and maps detections/redactions back). No other host concept leaks in.
 */
export interface GenericDomNode {
  /** Adapter-assigned stable id, used to correlate SensitiveRegions and write redactions back. */
  id: string;
  tagName: string | null;
  /** Shallow key/value attribute bag (e.g. type, autocomplete, placeholder, aria-label, value, href, name). */
  attributes: Record<string, string>;
  /** Own text content of this node (not children's), if any. */
  text?: string;
  /** True if this node is a text-only leaf (maps e.g. to NanoBrowser's DOMTextNode). */
  isTextNode?: boolean;
  /**
   * This node's on-screen position, in the SAME pixel coordinate space as the
   * screenshot passed alongside it in PageContext, if the host agent's DOM
   * extraction provides it. When present, a DOM-anchored SensitiveRegion for
   * this node can ALSO be blacked out on the screenshot at these coordinates
   * — see PrivacyEngine's redaction step. This is a coordinate correlation,
   * NOT OCR: it blacks out a KNOWN sensitive field's rectangle regardless of
   * what pixels are rendered there. It does nothing for sensitive text that
   * has no corresponding DOM node (e.g. text baked into an image). See
   * `privacy-engine/docs/screenshot-text-pii.md`.
   */
  bbox?: BoundingBox;
  children: GenericDomNode[];
}

export interface DOMSnapshot {
  root: GenericDomNode;
  /** Flat index of every node in `root`, keyed by GenericDomNode.id, for O(1) lookups. */
  nodesById: Map<string, GenericDomNode>;
}

/** A single browser tab's identity — url/title are exactly the kind of thing
 *  that can carry PII (e.g. a URL with a query-string email, or a tab titled
 *  with someone's name) and MUST be sanitized like everything else. */
export interface TabContext {
  id: number;
  url?: string;
  title?: string;
}

/** A named piece of free text that must be scanned/redacted before it can
 *  leave the device — e.g. an action's extracted content or error message.
 *  The `id` is for provenance/audit only (see PrivacyMetadata), never content. */
export interface NamedText {
  id: string;
  text: string;
}

/** Raw input handed to the engine by an agent adapter. Everything here may be sensitive. */
export interface PageContext {
  url?: string;
  title?: string;
  dom?: DOMSnapshot;
  /** Base64 (no data: prefix) or data: URL JPEG/PNG screenshot. */
  screenshot?: string | null;
  /** Other open tabs — same trust level as `url`/`title` above. */
  tabs?: TabContext[];
  /** Free-form additional text an adapter wants scanned (e.g. extracted page text, action results). */
  extraText?: NamedText[];
}

/** One sensitive region found by one or more detectors, after fusion. */
export interface SensitiveRegion {
  id: string;
  type: SensitiveDataType;
  source: DetectionSource;
  /** All sources that independently flagged this region, once merged by DetectionFusion. */
  mergedSources?: DetectionSource[];
  confidence: number; // 0..1
  action: RedactionAction;
  /** Present for DOM-based detections: which generic node + attribute/text this refers to. */
  domNodeId?: string;
  domField?: string; // e.g. 'attributes.value', 'attributes.placeholder', 'text'
  /** Present for detections in a flat named text field (url/title/tab/extraText) — see NamedText.id
   *  and the reserved ids 'url' and 'title' used for the current page's own url/title. */
  textField?: string;
  /** Present for vision-based detections. */
  bbox?: BoundingBox;
  /** The literal matched/raw value is NEVER stored here. This is metadata only. */
}

export interface PrivacyMetadata {
  /** True only if every detector needed for this context ran successfully. */
  analysisComplete: boolean;
  detectedCount: number;
  redactedCount: number;
  sourcesUsed: DetectionSource[];
  /** Populated when analysisComplete is false. */
  degradedReason?: string;
  timings: {
    domMs?: number;
    regexMs?: number;
    nerMs?: number;
    visionMs?: number;
    fusionMs?: number;
    redactionMs?: number;
    totalMs: number;
  };
}

export interface SanitizedContext {
  /** Sanitized — NEVER the raw value passed into PageContext. */
  url?: string;
  /** Sanitized — NEVER the raw value passed into PageContext. */
  title?: string;
  /** Sanitized versions of PageContext.tabs, same order/ids. */
  tabs?: TabContext[];
  /** The redacted DOM tree, safe to serialize/send. */
  sanitizedDom?: DOMSnapshot;
  /** The redacted screenshot, safe to send (undefined if none was provided). */
  sanitizedScreenshot?: string | null;
  /** Sanitized versions of PageContext.extraText, same order/ids. */
  sanitizedExtraText?: NamedText[];
  sensitiveRegions: SensitiveRegion[];
  privacyMetadata: PrivacyMetadata;
}

/**
 * Result of PrivacyEngine.sanitize(). This is the ONLY way an adapter is allowed
 * to obtain data destined for the network. See Part 6 (fail-closed):
 * when `allowed` is false, `context` in the failure branch carries NOTHING
 * derived from the raw page — callers must not fall back to raw data.
 */
export type PrivacyResult =
  | { allowed: true; context: SanitizedContext }
  | { allowed: false; reason: string };

export interface DetectorInput {
  dom?: DOMSnapshot;
  screenshot?: string | null;
  /** Flat map of fieldId -> text for everything that isn't DOM-anchored
   *  (url, title, each tab's url/title, extraText entries). Detectors that
   *  don't understand flat text (e.g. VisionDetector) simply ignore this. */
  textFields?: Record<string, string>;
}

export interface Detector {
  readonly source: DetectionSource;
  /** Must never throw for "no findings" — throw only for genuine failure (caller decides fail-open/closed). */
  detect(input: DetectorInput): Promise<SensitiveRegion[]>;
}
