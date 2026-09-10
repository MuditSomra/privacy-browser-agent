import { HumanMessage, type SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { wrapUntrustedContent } from '../messages/utils';
import { createLogger } from '@src/background/log';
import { NanoBrowserAdapter } from '@src/privacy-engine/adapters/nanobrowser/NanoBrowserAdapter';
import { PrivacyBlockedError } from '@src/background/agent/agents/errors';

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
    const browserState = await context.browserContext.getState(context.options.useVision);

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
    const privacyResult = await privacyAdapter.sanitizeBrowserState(browserState, context.options.includeAttributes, actionResultsInput);
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
