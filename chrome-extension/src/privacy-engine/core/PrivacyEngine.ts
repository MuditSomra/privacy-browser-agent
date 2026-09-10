/**
 * privacy-engine/core/PrivacyEngine.ts
 *
 * The single entry point an agent adapter calls before any network request.
 * See Part 6 (fail-closed): if DOM detection, regex detection, or (when a
 * screenshot is present) vision detection cannot complete, `sanitize()`
 * returns `{ allowed: false, reason }` and NEVER returns raw page data.
 * There is no fallback path in this file that returns the original,
 * unredacted PageContext.
 */
import type { Detector, NamedText, PageContext, PrivacyMetadata, PrivacyResult, SensitiveRegion, DetectionSource, TabContext } from './types';
import { PrivacyPolicy } from './PrivacyPolicy';
import { DOMDetector } from '../detection/DOMDetector';
import { RegexDetector } from '../detection/RegexDetector';
import { VisionDetector } from '../detection/VisionDetector';
import { DetectionFusion } from '../fusion/DetectionFusion';
import { DOMRedactor } from '../redaction/DOMRedactor';
import { ImageRedactor } from '../redaction/ImageRedactor';
import { TextRedactor } from '../redaction/TextRedactor';
import { createEngineLogger } from './logger';

const logger = createEngineLogger('PrivacyEngine');

/** Reserved textField ids for the current page's own url/title. Tabs use `tab:{id}:url` / `tab:{id}:title`. */
export const URL_FIELD = 'url';
export const TITLE_FIELD = 'title';
export const tabUrlField = (tabId: number) => `tab:${tabId}:url`;
export const tabTitleField = (tabId: number) => `tab:${tabId}:title`;

export interface PrivacyEngineConfig {
  policy?: PrivacyPolicy;
  domDetector?: Detector;
  regexDetector?: Detector;
  visionDetector?: Detector;
  fusion?: DetectionFusion;
  domRedactor?: DOMRedactor;
  imageRedactor?: ImageRedactor;
  textRedactor?: TextRedactor;
  /**
   * If true (default), a screenshot that cannot be analyzed by the vision
   * detector causes the whole call to fail closed. Set false only for agents
   * that never attach screenshots to network requests (text-only agents).
   */
  requireVisionForScreenshots?: boolean;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Flattens url/title/tabs/extraText into a single fieldId -> text map for the
 *  detectors/TextRedactor, which only understand flat text, not PageContext shape. */
function buildTextFields(pageContext: PageContext): Record<string, string> {
  const fields: Record<string, string> = {};
  if (pageContext.url) fields[URL_FIELD] = pageContext.url;
  if (pageContext.title) fields[TITLE_FIELD] = pageContext.title;
  for (const tab of pageContext.tabs ?? []) {
    if (tab.url) fields[tabUrlField(tab.id)] = tab.url;
    if (tab.title) fields[tabTitleField(tab.id)] = tab.title;
  }
  for (const entry of pageContext.extraText ?? []) {
    fields[entry.id] = entry.text;
  }
  return fields;
}

export class PrivacyEngine {
  private policy: PrivacyPolicy;
  private domDetector: Detector;
  private regexDetector: Detector;
  private visionDetector: Detector;
  private fusion: DetectionFusion;
  private domRedactor: DOMRedactor;
  private imageRedactor: ImageRedactor;
  private textRedactor: TextRedactor;
  private requireVisionForScreenshots: boolean;

  constructor(config?: PrivacyEngineConfig) {
    this.policy = config?.policy ?? new PrivacyPolicy();
    this.domDetector = config?.domDetector ?? new DOMDetector();
    this.regexDetector = config?.regexDetector ?? new RegexDetector();
    this.visionDetector = config?.visionDetector ?? new VisionDetector();
    this.fusion = config?.fusion ?? new DetectionFusion();
    this.domRedactor = config?.domRedactor ?? new DOMRedactor();
    this.imageRedactor = config?.imageRedactor ?? new ImageRedactor();
    this.textRedactor = config?.textRedactor ?? new TextRedactor();
    this.requireVisionForScreenshots = config?.requireVisionForScreenshots ?? true;
  }

  async sanitize(pageContext: PageContext): Promise<PrivacyResult> {
    const totalStart = now();
    const timings: PrivacyMetadata['timings'] = { totalMs: 0 };
    const sourcesUsed: DetectionSource[] = [];
    const allRegions: SensitiveRegion[] = [];

    // url/title/tabs/extraText are just as capable of carrying PII (a name in
    // a tab title, an email in a query string, PII echoed back in an action's
    // extractedContent/error) as the DOM or a screenshot, so they go through
    // the SAME detection + redaction pipeline, not a raw pass-through.
    const textFields = buildTextFields(pageContext);

    // --- DOM detection ---
    if (pageContext.dom) {
      try {
        const t0 = now();
        const regions = await this.domDetector.detect({ dom: pageContext.dom });
        timings.domMs = now() - t0;
        allRegions.push(...regions);
        sourcesUsed.push('dom');
      } catch (err) {
        return this.failClosed('DOM detection failed', err);
      }
    }

    // --- Regex detection (DOM text/attrs + url/title/tabs/extraText) ---
    try {
      const t0 = now();
      const regions = await this.regexDetector.detect({ dom: pageContext.dom, textFields });
      timings.regexMs = now() - t0;
      allRegions.push(...regions);
      sourcesUsed.push('regex');
    } catch (err) {
      return this.failClosed('Regex/structured detection failed', err);
    }

    // --- Vision detection (only if a screenshot was supplied) ---
    if (pageContext.screenshot) {
      try {
        const t0 = now();
        const regions = await this.visionDetector.detect({ screenshot: pageContext.screenshot });
        timings.visionMs = now() - t0;
        allRegions.push(...regions);
        sourcesUsed.push('vision');
      } catch (err) {
        if (this.requireVisionForScreenshots) {
          return this.failClosed('Vision analysis of screenshot failed; refusing to transmit an unanalyzed screenshot', err);
        }
        logger.warning('Vision analysis failed but requireVisionForScreenshots=false; continuing without vision.', err);
      }
    }

    // --- Fusion ---
    let fused: SensitiveRegion[];
    try {
      const t0 = now();
      fused = this.fusion.fuse(allRegions);
      // Apply policy to decide the final action per region (detectors only propose a default).
      fused = fused.map(r => ({ ...r, action: this.policy.actionFor(r.type) }));
      timings.fusionMs = now() - t0;
    } catch (err) {
      return this.failClosed('Detection fusion failed', err);
    }

    // --- Redaction ---
    let redactedCount = 0;
    try {
      const t0 = now();
      if (pageContext.dom) {
        redactedCount += this.domRedactor.redact(pageContext.dom, fused.filter(r => r.domNodeId));
      }

      let sanitizedScreenshot: string | null | undefined = pageContext.screenshot ?? undefined;
      if (pageContext.screenshot) {
        // Screenshot regions come from two sources: pure vision detections
        // (faces/persons/document-like objects) AND any DOM-anchored region
        // whose node carries known on-screen coordinates (`bbox`) — e.g. a
        // password field's rectangle — so a sensitive DOM field is blacked
        // out in the screenshot too, not just replaced in the text listing.
        // This is coordinate correlation, not OCR; see
        // privacy-engine/docs/screenshot-text-pii.md for what it does and
        // does not cover.
        const screenshotRegions = fused.filter(r => r.bbox && r.action !== 'ALLOW');
        sanitizedScreenshot = await this.imageRedactor.redact(
          pageContext.screenshot,
          screenshotRegions.map(r => r.bbox!),
        );
        redactedCount += screenshotRegions.length;
      }

      const textRegions = fused.filter(r => r.textField);
      const { redacted: redactedFields, redactedCount: textRedactedCount } = this.textRedactor.redact(textFields, textRegions);
      redactedCount += textRedactedCount;

      const sanitizedTabs: TabContext[] | undefined = pageContext.tabs?.map(tab => ({
        id: tab.id,
        url: tab.url !== undefined ? redactedFields[tabUrlField(tab.id)] : undefined,
        title: tab.title !== undefined ? redactedFields[tabTitleField(tab.id)] : undefined,
      }));
      const sanitizedExtraText: NamedText[] | undefined = pageContext.extraText?.map(entry => ({
        id: entry.id,
        text: redactedFields[entry.id] ?? entry.text,
      }));

      timings.redactionMs = now() - t0;
      timings.totalMs = now() - totalStart;

      return {
        allowed: true,
        context: {
          url: pageContext.url !== undefined ? redactedFields[URL_FIELD] : undefined,
          title: pageContext.title !== undefined ? redactedFields[TITLE_FIELD] : undefined,
          tabs: sanitizedTabs,
          sanitizedDom: pageContext.dom,
          sanitizedScreenshot: pageContext.screenshot ? sanitizedScreenshot : null,
          sanitizedExtraText,
          sensitiveRegions: fused,
          privacyMetadata: {
            analysisComplete: true,
            detectedCount: fused.length,
            redactedCount,
            sourcesUsed,
            timings,
          },
        },
      };
    } catch (err) {
      return this.failClosed('Redaction failed', err);
    }
  }

  private failClosed(reason: string, err: unknown): PrivacyResult {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error(`Fail-closed: ${reason}: ${detail}`);
    return { allowed: false, reason: `${reason}: ${detail}` };
  }
}
