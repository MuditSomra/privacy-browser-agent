import { privacyFlowStore } from '@extension/storage';
import { HumanMessage, type SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { wrapUntrustedContent } from '../messages/utils';
import { createLogger } from '@src/background/log';
import { NanoBrowserAdapter } from '@src/privacy-engine/adapters/nanobrowser/NanoBrowserAdapter';
import { PrivacyBlockedError } from '@src/background/agent/agents/errors';
import type { BrowserState } from '@src/background/browser/views';

const logger = createLogger('BasePrompt');

// Shared across prompt instances: the vision model (if used) only needs to be
// loaded once, and detector/policy config is process-wide for now.
const privacyAdapter = new NanoBrowserAdapter();

/**
 * Abstract base class for all prompt types
 */
abstract class BasePrompt {
  /**
   * Returns the system message that defines the AI's role and behavior
   * @returns SystemMessage from LangChain
   */
  abstract getSystemMessage(): SystemMessage;

  /**
   * Returns the user message for the specific prompt type
   * @param context - Optional context data needed for generating the user message
   * @returns HumanMessage from LangChain
   */
  abstract getUserMessage(context: AgentContext): Promise<HumanMessage>;

  /**
   * Builds the user message containing the browser state
   * @param context - The agent context
   * @returns HumanMessage from LangChain
   */
  async buildBrowserStateUserMessage(context: AgentContext): Promise<HumanMessage> {
    let browserState: BrowserState;
    if (context.options.useVision) {
      browserState = await context.browserContext.getState(true);
    } else {
      try {
        browserState = await context.browserContext.getState(true);
      } catch {
        browserState = await context.browserContext.getState(false);
      }
    }

    // Ensure we capture a screenshot for local privacy analysis and the transparency inspector
    if (!browserState.screenshot && typeof context.browserContext?.getCurrentPage === 'function') {
      try {
        const currentPage = await context.browserContext.getCurrentPage();
        if (currentPage && typeof currentPage.takeScreenshot === 'function') {
          const shot = await currentPage.takeScreenshot();
          if (shot) {
            browserState.screenshot = shot;
          }
        }
      } catch (err) {
        logger.debug('Could not capture fallback screenshot in BasePrompt:', err);
      }
    }

    // Action results/extracted content can themselves contain PII echoed back
    // from the page (e.g. an extracted email or name), so they go through the
    // SAME privacy engine call as the DOM/screenshot/url/title/tabs below —
    // never appended to the prompt separately from raw `context.actionResults`.
    const actionResultsInput = context.actionResults.flatMap((result, i) => {
      const entries: { id: string; text: string }[] = [];
      if (result.extractedContent) {
        entries.push({ id: `actionResult:${i}:content`, text: result.extractedContent });
      }
      if (result.error) {
        entries.push({ id: `actionResult:${i}:error`, text: result.error });
      }
      return entries;
    });

    // PRIVACY BOUNDARY: everything below this point that reaches `stateDescription`
    // or the outgoing HumanMessage must come from `privacyResult`, never directly
    // from `browserState` or `context.actionResults`. See
    // privacy-engine/core/PrivacyEngine.ts (fail-closed): if local PII/vision
    // analysis cannot be completed, we do not fall back to raw data — the step
    // throws instead. This covers the DOM, the screenshot, the current tab's
    // url/title, every other open tab's url/title, AND action-result text —
    // there is no raw field from `browserState`/`context.actionResults` used
    // anywhere past this call.
    const privacyResult = await privacyAdapter.sanitizeBrowserState(
      browserState,
      context.options.includeAttributes,
      actionResultsInput,
      context.options.useVision,
    );
    if (!privacyResult.allowed) {
      throw new PrivacyBlockedError(
        `Privacy analysis of the current page could not be completed, so nothing was sent to the model. ${privacyResult.reason}`,
      );
    }
    logger.info(
      `Privacy engine: ${privacyResult.sensitiveRegions.length} sensitive region(s) detected and redacted ` +
        `(sources: ${privacyResult.privacyMetadata.sourcesUsed.join(', ') || 'none'}, ` +
        `${privacyResult.privacyMetadata.timings.totalMs.toFixed(1)}ms)`,
    );

    const rawElementsText = privacyResult.elementsText;

    // Record Stage 1 (Sanitization) and Stage 2 (Outgoing to Server) for extension transparency indicator
    try {
      const sensitiveTypes = Array.from(new Set(privacyResult.sensitiveRegions.map(r => r.type)));
      const sampleTokens: string[] = [];
      const matches = rawElementsText.match(/\[[A-Z_]+_REDACTED\]/g);
      if (matches) {
        sampleTokens.push(...Array.from(new Set(matches)).slice(0, 5));
      }

      const dataKeysFound: string[] = [];
      const dataKeyMatches = rawElementsText.match(/profile\.[a-zA-Z0-9_]+/g);
      if (dataKeyMatches) {
        dataKeysFound.push(...Array.from(new Set(dataKeyMatches)));
      }

      const stepNum = context.stepInfo ? context.stepInfo.stepNumber + 1 : 1;
      const taskId = context.taskId || 'default_task';
      const textPreview =
        rawElementsText.length > 250
          ? rawElementsText.substring(0, 250) + '...'
          : rawElementsText || 'Empty page elements';

      const sanitizedScreenshotUrl = privacyResult.screenshot
        ? privacyResult.screenshot.startsWith('data:')
          ? privacyResult.screenshot
          : `data:image/jpeg;base64,${privacyResult.screenshot}`
        : null;

      const rawScreenshotUrl = browserState.screenshot
        ? browserState.screenshot.startsWith('data:')
          ? browserState.screenshot
          : `data:image/jpeg;base64,${browserState.screenshot}`
        : null;

      // Log in both production and development mode for complete transparency
      console.group(
        `%c🛡️ [PRIVACY ENGINE] Step ${stepNum} — Sanitized Page & Screenshot`,
        'background: #047857; color: #6ee7b7; font-weight: bold; font-size: 11px; padding: 3px 6px; border-radius: 4px;',
      );
      console.log('🛡️ Step Details:', {
        stepNumber: stepNum,
        taskId,
        url: privacyResult.url || browserState.url,
        title: privacyResult.title || browserState.title,
        sensitiveRegionsCount: privacyResult.sensitiveRegions.length,
        redactionsCount: privacyResult.privacyMetadata.redactedCount ?? privacyResult.sensitiveRegions.length,
        sources: privacyResult.privacyMetadata.sourcesUsed,
        hasSanitizedScreenshot: Boolean(sanitizedScreenshotUrl),
      });

      if (sanitizedScreenshotUrl) {
        console.log('🛡️ [SANITIZED SCREENSHOT PREVIEW] Blackout rectangles applied on-device:');
        console.log(
          '%c ',
          `font-size: 1px; padding: 100px 160px; background-image: url("${sanitizedScreenshotUrl}"); background-size: contain; background-repeat: no-repeat; background-position: center; border: 2px solid #10b981; border-radius: 8px; background-color: #0b1329; margin: 4px 0;`,
        );
        console.log('🛡️ Sanitized Image (Data URL click/copy):', sanitizedScreenshotUrl);
      } else {
        console.log('🛡️ [SANITIZED SCREENSHOT] No screenshot available or needed for this step (Text-Only DOM).');
      }
      console.groupEnd();

      privacyFlowStore
        .addStep({
          stepNumber: stepNum,
          taskId,
          url: privacyResult.url || browserState.url || '',
          title: privacyResult.title || browserState.title || '',
          sanitization: {
            sensitiveCount: privacyResult.sensitiveRegions.length,
            types: sensitiveTypes,
            sources: privacyResult.privacyMetadata.sourcesUsed || [],
            redactionsCount: privacyResult.privacyMetadata.redactedCount ?? privacyResult.sensitiveRegions.length,
            summary: `${privacyResult.sensitiveRegions.length} sensitive item(s) detected and redacted.`,
            sampleRedactions: sampleTokens,
            screenshotRedacted: Boolean(privacyResult.screenshot),
            sanitizedScreenshot: sanitizedScreenshotUrl,
            rawScreenshot: rawScreenshotUrl,
            visionRegionsCount: privacyResult.sensitiveRegions.filter(r => r.source === 'vision').length,
            ocrRegionsCount: privacyResult.sensitiveRegions.filter(r => r.source === 'ocr').length,
            domRegionsCount: privacyResult.sensitiveRegions.filter(r => r.source === 'dom').length,
          },
          outgoing: {
            modelName: 'Remote Agent LLM',
            provider: 'Remote AI Provider',
            charCount: rawElementsText.length,
            sanitizedTextPreview: textPreview,
            hasScreenshot: Boolean(privacyResult.screenshot && context.options.useVision),
            dataKeysIncluded: dataKeysFound,
          },
        })
        .catch(err => logger.warning('Failed to persist privacy flow step:', err));
    } catch (err) {
      logger.warning('Failed to record privacy flow event in prompt:', err);
    }

    let formattedElementsText = '';
    if (rawElementsText !== '') {
      const scrollInfo = `[Scroll info of current page] window.scrollY: ${browserState.scrollY}, document.body.scrollHeight: ${browserState.scrollHeight}, window.visualViewport.height: ${browserState.visualViewportHeight}, visual viewport height as percentage of scrollable distance: ${Math.round((browserState.visualViewportHeight / (browserState.scrollHeight - browserState.visualViewportHeight)) * 100)}%\n`;
      logger.info(scrollInfo);
      const elementsText = wrapUntrustedContent(rawElementsText);
      formattedElementsText = `${scrollInfo}[Start of page]\n${elementsText}\n[End of page]\n`;
    } else {
      formattedElementsText = 'empty page';
    }

    let stepInfoDescription = '';
    if (context.stepInfo) {
      stepInfoDescription = `Current step: ${context.stepInfo.stepNumber + 1}/${context.stepInfo.maxSteps}`;
    }

    const timeStr = new Date().toISOString().slice(0, 16).replace('T', ' '); // Format: YYYY-MM-DD HH:mm
    stepInfoDescription += `Current date and time: ${timeStr}`;

    // Sanitized action results only — see the privacy-boundary note above.
    let actionResultsDescription = '';
    const sanitizedActionResults = privacyResult.actionResults ?? [];
    const byIndex = new Map(sanitizedActionResults.map(entry => [entry.id, entry.text]));
    for (let i = 0; i < context.actionResults.length; i++) {
      const content = byIndex.get(`actionResult:${i}:content`);
      if (content !== undefined) {
        actionResultsDescription += `\nAction result ${i + 1}/${context.actionResults.length}: ${content}`;
      }
      const error = byIndex.get(`actionResult:${i}:error`);
      if (error !== undefined) {
        // only use last line of error
        const lastLine = error.split('\n').pop();
        actionResultsDescription += `\nAction error ${i + 1}/${context.actionResults.length}: ...${lastLine}`;
      }
    }

    // Sanitized url/title/tabs only — see the privacy-boundary note above.
    const currentTab = `{id: ${browserState.tabId}, url: ${privacyResult.url ?? ''}, title: ${privacyResult.title ?? ''}}`;
    const otherTabs = (privacyResult.tabs ?? [])
      .filter(tab => tab.id !== browserState.tabId)
      .map(tab => `- {id: ${tab.id}, url: ${tab.url ?? ''}, title: ${tab.title ?? ''}}`);
    const stateDescription = `
[Task history memory ends]
[Current state starts here]
The following is one-time information - if you need to remember it write it to memory:
Current tab: ${currentTab}
Other available tabs:
  ${otherTabs.join('\n')}
Interactive elements from top layer of the current page inside the viewport:
${formattedElementsText}
${stepInfoDescription}
${actionResultsDescription}
`;

    if (privacyResult.screenshot && context.options.useVision) {
      // privacyResult.screenshot has already been through vision-based redaction
      // (faces/persons/document-like regions blacked out) — see VisionDetector +
      // ImageRedactor. It may already be a data: URL; normalize either form.
      const screenshotDataUrl = privacyResult.screenshot.startsWith('data:')
        ? privacyResult.screenshot
        : `data:image/jpeg;base64,${privacyResult.screenshot}`;
      return new HumanMessage({
        content: [
          { type: 'text', text: stateDescription },
          {
            type: 'image_url',
            image_url: { url: screenshotDataUrl },
          },
        ],
      });
    }

    return new HumanMessage(stateDescription);
  }
}

export { BasePrompt };
