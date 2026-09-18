import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  privacyFlowStore,
  type PrivacyFlowStepRecord,
  type PrivacyFlowState,
  type PrivacyStageSanitization,
  type PrivacyStageOutgoing,
  type PrivacyStageIncoming,
  type PrivacyStageLocalResolution,
  DEFAULT_PRIVACY_FLOW_STATE,
} from '@extension/storage';
import {
  FiShield,
  FiX,
  FiLock,
  FiSend,
  FiServer,
  FiCheckCircle,
  FiCpu,
  FiEye,
  FiRefreshCw,
  FiImage,
  FiMaximize2,
  FiChevronLeft,
  FiChevronRight,
  FiCopy,
  FiExternalLink,
} from 'react-icons/fi';

interface PrivacyFlowModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDarkMode?: boolean;
  focusedStepNumber?: number | null;
  currentTaskId?: string | null;
}

// Normalization function to guarantee every step record is 100% well-formed
// regardless of any corrupt or legacy storage data
function normalizeStepRecord(raw: any, index: number): PrivacyFlowStepRecord {
  const stepNumber = typeof raw?.stepNumber === 'number' && !isNaN(raw.stepNumber) ? raw.stepNumber : index + 1;
  const stepId = String(raw?.stepId || `step_${stepNumber}_${Date.now()}_${index}`);
  const taskId = String(raw?.taskId || '');
  const timestamp = typeof raw?.timestamp === 'number' && !isNaN(raw.timestamp) ? raw.timestamp : Date.now();
  const url = String(raw?.url || '');
  const title = String(raw?.title || '');

  const rawSan = raw?.sanitization && typeof raw.sanitization === 'object' ? raw.sanitization : {};
  const types = Array.isArray(rawSan.types) ? rawSan.types.filter((t: any) => typeof t === 'string') : [];
  const sources = Array.isArray(rawSan.sources) ? rawSan.sources.filter((s: any) => typeof s === 'string') : [];
  const redactionsCount =
    typeof rawSan.redactionsCount === 'number' && !isNaN(rawSan.redactionsCount)
      ? rawSan.redactionsCount
      : typeof rawSan.sensitiveCount === 'number' && !isNaN(rawSan.sensitiveCount)
        ? rawSan.sensitiveCount
        : types.length;
  const sensitiveCount =
    typeof rawSan.sensitiveCount === 'number' && !isNaN(rawSan.sensitiveCount)
      ? rawSan.sensitiveCount
      : redactionsCount;

  const sanitization: PrivacyStageSanitization = {
    sensitiveCount,
    types,
    sources,
    redactionsCount,
    summary:
      typeof rawSan.summary === 'string' && rawSan.summary.trim()
        ? rawSan.summary
        : redactionsCount > 0
          ? `${redactionsCount} sensitive item(s) detected and redacted.`
          : 'Clean page (0 sensitive items).',
    sampleRedactions: Array.isArray(rawSan.sampleRedactions)
      ? rawSan.sampleRedactions.filter((r: any) => typeof r === 'string')
      : [],
    screenshotRedacted: Boolean(rawSan.screenshotRedacted || rawSan.sanitizedScreenshot),
    sanitizedScreenshot: typeof rawSan.sanitizedScreenshot === 'string' ? rawSan.sanitizedScreenshot : null,
    rawScreenshot: typeof rawSan.rawScreenshot === 'string' ? rawSan.rawScreenshot : null,
    visionRegionsCount: typeof rawSan.visionRegionsCount === 'number' ? rawSan.visionRegionsCount : 0,
    ocrRegionsCount: typeof rawSan.ocrRegionsCount === 'number' ? rawSan.ocrRegionsCount : 0,
    domRegionsCount: typeof rawSan.domRegionsCount === 'number' ? rawSan.domRegionsCount : 0,
  };

  const rawOut = raw?.outgoing && typeof raw.outgoing === 'object' ? raw.outgoing : {};
  const outgoing: PrivacyStageOutgoing = {
    modelName: String(rawOut.modelName || 'Local / Remote LLM'),
    provider: String(rawOut.provider || 'AI Provider'),
    charCount: typeof rawOut.charCount === 'number' ? rawOut.charCount : 0,
    sanitizedTextPreview: String(rawOut.sanitizedTextPreview || 'No outgoing text payload captured.'),
    hasScreenshot: Boolean(rawOut.hasScreenshot || sanitization.sanitizedScreenshot),
    dataKeysIncluded: Array.isArray(rawOut.dataKeysIncluded) ? rawOut.dataKeysIncluded : [],
  };

  const incoming: PrivacyStageIncoming | undefined =
    raw?.incoming && typeof raw.incoming === 'object'
      ? {
          actionName: String(raw.incoming.actionName || 'execute_action'),
          abstractPlanPreview: String(raw.incoming.abstractPlanPreview || 'No abstract plan preview.'),
          dataKeysUsed: Array.isArray(raw.incoming.dataKeysUsed) ? raw.incoming.dataKeysUsed : [],
        }
      : undefined;

  const rawRes = raw?.localResolution && typeof raw.localResolution === 'object' ? raw.localResolution : undefined;
  const localResolution: PrivacyStageLocalResolution | undefined = rawRes
    ? {
        resolvedKeys: Array.isArray(rawRes.resolvedKeys) ? rawRes.resolvedKeys : [],
        elementIndex: typeof rawRes.elementIndex === 'number' ? rawRes.elementIndex : undefined,
        sanitizedMessage: String(rawRes.sanitizedMessage || 'Credentials securely filled directly into DOM.'),
        timestamp: typeof rawRes.timestamp === 'number' ? rawRes.timestamp : Date.now(),
      }
    : undefined;

  return {
    stepId,
    stepNumber,
    taskId,
    timestamp,
    url,
    title,
    sanitization,
    outgoing,
    incoming,
    localResolution,
  };
}

export const PrivacyFlowModal: React.FC<PrivacyFlowModalProps> = ({
  isOpen,
  onClose,
  isDarkMode = false,
  focusedStepNumber = null,
  currentTaskId = null,
}) => {
  const [flowState, setFlowState] = useState<PrivacyFlowState>(DEFAULT_PRIVACY_FLOW_STATE);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'sanitization' | 'images' | 'outgoing' | 'incoming' | 'local'>(
    'all',
  );
  const [imageViewModel, setImageViewModel] = useState<'sanitized' | 'raw' | 'comparison'>('sanitized');
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<'current' | 'all'>('current');
  const [copiedDataUrl, setCopiedDataUrl] = useState(false);

  const userSelectedRef = useRef(false);

  const handleCopyImageData = (dataUrl: string) => {
    try {
      navigator.clipboard.writeText(dataUrl);
      setCopiedDataUrl(true);
      setTimeout(() => setCopiedDataUrl(false), 2000);
    } catch {
      // ignore clipboard error
    }
  };

  const handleOpenImageInTab = (dataUrl: string) => {
    try {
      const newWindow = window.open();
      if (newWindow) {
        newWindow.document.write(
          `<title>Sanitized Screenshot - Preview</title><body style="margin:0;background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;"><img src="${dataUrl}" style="max-width:98vw;max-height:98vh;border:1px solid #334155;box-shadow:0 10px 25px rgba(0,0,0,0.5);border-radius:8px;" /></body>`,
        );
      }
    } catch {
      // ignore window.open error
    }
  };

  useEffect(() => {
    if (!isOpen) {
      userSelectedRef.current = false;
      return;
    }

    // Fetch initial state
    privacyFlowStore
      .get()
      .then(state => {
        if (state && Array.isArray(state.steps)) {
          setFlowState(state);
        }
      })
      .catch(() => {
        // ignore store get error
      });

    // Subscribe to live storage updates
    const unsubscribe = privacyFlowStore.subscribe(() => {
      try {
        const snapshot = privacyFlowStore.getSnapshot();
        if (snapshot && Array.isArray(snapshot.steps)) {
          setFlowState(snapshot);
        }
      } catch {
        // ignore subscription snapshot error
      }
    });

    return () => {
      unsubscribe();
    };
  }, [isOpen]);

  const allSteps = useMemo(() => {
    if (!flowState || !Array.isArray(flowState.steps)) return [];
    return flowState.steps
      .filter((s): s is PrivacyFlowStepRecord => Boolean(s && typeof s === 'object'))
      .map((s, idx) => normalizeStepRecord(s, idx));
  }, [flowState]);

  // Available unique tasks in history
  const availableTasks = useMemo(() => {
    const tasks = new Set<string>();
    allSteps.forEach(s => {
      if (s?.taskId) tasks.add(s.taskId);
    });
    return Array.from(tasks);
  }, [allSteps]);

  // Determine active task ID: prefer prop, otherwise latest step's task ID
  const activeTaskId = currentTaskId || (allSteps.length > 0 ? allSteps[allSteps.length - 1]?.taskId : null);

  // Filter steps based on task filter
  const displayedSteps = useMemo(() => {
    if (taskFilter === 'current' && activeTaskId) {
      const filtered = allSteps.filter(s => s?.taskId === activeTaskId);
      return filtered.length > 0 ? filtered : allSteps;
    }
    return allSteps;
  }, [allSteps, taskFilter, activeTaskId]);

  // Keep selectedStepId valid or set default on initial open
  useEffect(() => {
    if (displayedSteps.length === 0) {
      setSelectedStepId(null);
      return;
    }

    // If focused step number is requested explicitly
    if (focusedStepNumber !== null && focusedStepNumber !== undefined) {
      const matched = displayedSteps.find(s => s?.stepNumber === focusedStepNumber);
      if (matched?.stepId) {
        setSelectedStepId(matched.stepId);
        return;
      }
    }

    // If user has manually selected a step, keep it if it exists in displayedSteps
    if (userSelectedRef.current && selectedStepId) {
      const exists = displayedSteps.some(s => s?.stepId === selectedStepId);
      if (exists) return;
    }

    // Default to the latest step in displayed list
    const latest = displayedSteps[displayedSteps.length - 1];
    if (latest?.stepId) {
      setSelectedStepId(latest.stepId);
    }
  }, [displayedSteps, focusedStepNumber]);

  // Compute currentStep BEFORE the early return so all hooks below can reference it
  const currentStepIndex = displayedSteps.findIndex(s => s?.stepId === selectedStepId);
  const currentStep: PrivacyFlowStepRecord | undefined =
    currentStepIndex !== -1
      ? displayedSteps[currentStepIndex]
      : displayedSteps.length > 0
        ? displayedSteps[displayedSteps.length - 1]
        : undefined;

  // Safe console audit log — MUST be before the early return to keep hook count stable
  useEffect(() => {
    try {
      if (!isOpen || !currentStep) return;
      const urlPreview = currentStep.sanitization?.sanitizedScreenshot;
      console.group(
        `%c🛡️ [INSPECTOR AUDIT] Step ${currentStep.stepNumber} Active`,
        'background: #0284c7; color: #bae6fd; font-weight: bold; font-size: 11px; padding: 2px 6px; border-radius: 4px;',
      );
      console.log('Inspected Step:', {
        stepNumber: currentStep.stepNumber,
        taskId: currentStep.taskId,
        url: currentStep.url,
        redactionsCount: currentStep.sanitization?.redactionsCount ?? 0,
        hasSanitizedScreenshot: Boolean(urlPreview),
      });
      if (urlPreview) {
        console.log('🛡️ [SANITIZED SCREENSHOT PREVIEW] Blackout rectangles applied on-device:');
        if (urlPreview.length < 80000) {
          try {
            console.log(
              '%c ',
              `font-size: 1px; padding: 60px 100px; background-image: url("${urlPreview}"); background-size: contain; background-repeat: no-repeat; background-position: center; border: 2px solid #0284c7; border-radius: 6px; background-color: #0b1329; margin: 4px 0;`,
            );
          } catch {
            // ignore css console error
          }
        }
        console.log('🛡️ Sanitized Image Data URL available (length:', urlPreview.length, 'chars)');
      }
      console.groupEnd();
    } catch (err) {
      console.warn('[PrivacyFlowModal] Audit log warning:', err);
    }
  }, [isOpen, currentStep?.stepId]);

  if (!isOpen) return null;

  const handleSelectStep = (stepId: string) => {
    userSelectedRef.current = true;
    setSelectedStepId(stepId);
  };

  const handlePrevStep = () => {
    if (currentStepIndex > 0) {
      const prevStep = displayedSteps[currentStepIndex - 1];
      if (prevStep?.stepId) handleSelectStep(prevStep.stepId);
    }
  };

  const handleNextStep = () => {
    if (currentStepIndex < displayedSteps.length - 1) {
      const nextStep = displayedSteps[currentStepIndex + 1];
      if (nextStep?.stepId) handleSelectStep(nextStep.stepId);
    }
  };

  const sanitizedImg = currentStep?.sanitization?.sanitizedScreenshot;
  const rawImg = currentStep?.sanitization?.rawScreenshot;
  const hasSanitizedScreenshot = Boolean(sanitizedImg);
  const hasRawScreenshot = Boolean(rawImg);

  const getFormattedTime = (timestamp?: number) => {
    if (!timestamp) return 'Just now';
    try {
      const d = new Date(timestamp);
      return isNaN(d.getTime()) ? 'Just now' : d.toLocaleTimeString();
    } catch {
      return 'Just now';
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm"
      onClick={onClose}>
      <div
        className={`relative flex max-h-[94vh] w-full max-w-3xl flex-col rounded-2xl border shadow-2xl transition-all ${
          isDarkMode ? 'border-slate-700 bg-slate-900 text-gray-100' : 'border-slate-200 bg-white text-gray-800'
        }`}
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div
          className={`flex items-center justify-between border-b px-5 py-3.5 ${
            isDarkMode ? 'border-slate-800 bg-slate-900/90' : 'border-slate-100 bg-slate-50/90'
          }`}>
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-500 shadow-sm">
              <FiShield size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold tracking-tight">Privacy & Data Flow Inspector</h2>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                  <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  On-Device Protection Active
                </span>
              </div>
              <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                Visual audit of what leaves your browser, what AI models see, and how data resolves locally
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className={`rounded-lg p-1.5 transition-colors cursor-pointer ${
                isDarkMode
                  ? 'text-gray-400 hover:bg-slate-800 hover:text-white'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-black'
              }`}
              aria-label="Close Inspector">
              <FiX size={18} />
            </button>
          </div>
        </div>

        {/* Navigation & Controls Bar */}
        <div
          className={`flex flex-wrap items-center justify-between gap-3 border-b px-5 py-2.5 text-xs ${
            isDarkMode ? 'border-slate-800 bg-slate-950/60' : 'border-slate-100 bg-slate-50/60'
          }`}>
          {/* Step Selector Pills */}
          <div className="flex items-center gap-2 overflow-x-auto py-0.5 scrollbar-thin">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handlePrevStep}
                disabled={currentStepIndex <= 0}
                className={`rounded p-1 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                  isDarkMode ? 'hover:bg-slate-800 text-gray-300' : 'hover:bg-gray-200 text-gray-700'
                }`}
                title="Previous step">
                <FiChevronLeft size={14} />
              </button>
              <button
                type="button"
                onClick={handleNextStep}
                disabled={currentStepIndex >= displayedSteps.length - 1}
                className={`rounded p-1 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                  isDarkMode ? 'hover:bg-slate-800 text-gray-300' : 'hover:bg-gray-200 text-gray-700'
                }`}
                title="Next step">
                <FiChevronRight size={14} />
              </button>
            </div>

            <span className={`font-semibold shrink-0 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              Steps ({displayedSteps.length}):
            </span>

            {displayedSteps.map((step, idx) => {
              const isSelected = step?.stepId === currentStep?.stepId;
              const hasImg = Boolean(step?.sanitization?.sanitizedScreenshot);
              const count = step?.sanitization?.redactionsCount ?? 0;
              return (
                <button
                  key={step?.stepId || `step-${idx}`}
                  type="button"
                  onClick={() => step?.stepId && handleSelectStep(step.stepId)}
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-all cursor-pointer shrink-0 ${
                    isSelected
                      ? 'bg-sky-600 text-white shadow-md'
                      : isDarkMode
                        ? 'bg-slate-800 text-gray-300 hover:bg-slate-700'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}>
                  <span>Step {step?.stepNumber ?? idx + 1}</span>
                  {hasImg && (
                    <FiImage
                      size={11}
                      className={isSelected ? 'text-sky-200' : 'text-sky-500'}
                      title="Sanitized screenshot captured"
                    />
                  )}
                  {count > 0 && (
                    <span
                      className={`rounded-full px-1.5 py-0.2 text-[9px] font-bold ${
                        isSelected ? 'bg-white/20 text-white' : 'bg-emerald-500/20 text-emerald-400'
                      }`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Right Side: Task Filter & Stats */}
          <div className="flex items-center gap-3 shrink-0">
            {availableTasks.length > 1 && (
              <div className="flex items-center rounded-lg border p-0.5 text-[11px] dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setTaskFilter('current')}
                  className={`rounded px-2 py-0.5 font-medium transition-colors cursor-pointer ${
                    taskFilter === 'current'
                      ? 'bg-sky-600 text-white'
                      : isDarkMode
                        ? 'text-gray-400 hover:text-gray-200'
                        : 'text-gray-600 hover:text-black'
                  }`}>
                  Current Task
                </button>
                <button
                  type="button"
                  onClick={() => setTaskFilter('all')}
                  className={`rounded px-2 py-0.5 font-medium transition-colors cursor-pointer ${
                    taskFilter === 'all'
                      ? 'bg-sky-600 text-white'
                      : isDarkMode
                        ? 'text-gray-400 hover:text-gray-200'
                        : 'text-gray-600 hover:text-black'
                  }`}>
                  All ({allSteps.length})
                </button>
              </div>
            )}

            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold text-emerald-500">
                🛡️ {flowState?.totalRedactionsCount ?? 0} total redactions
              </span>
              <button
                type="button"
                onClick={() => privacyFlowStore.clear()}
                title="Clear inspection history"
                className={`flex items-center gap-1 text-[11px] underline opacity-70 hover:opacity-100 cursor-pointer ${
                  isDarkMode ? 'text-gray-400' : 'text-gray-500'
                }`}>
                <FiRefreshCw size={11} />
                Clear
              </button>
            </div>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {!currentStep ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-sky-500/10 text-sky-500 mb-3 shadow-sm">
                <FiShield size={28} />
              </div>
              <h3 className="text-base font-semibold">No Privacy Events Recorded Yet</h3>
              <p
                className={`mt-1.5 max-w-sm text-xs leading-relaxed ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                Run an agent task in the side panel. As the agent navigates pages, this inspector records every
                sensitive field redacted, previews the Zero-PII payload sent to the remote LLM, and reveals images
                sanitized by local vision models.
              </p>
            </div>
          ) : (
            <>
              {/* Step Summary Banner */}
              <div
                className={`rounded-xl border p-4 shadow-sm ${
                  isDarkMode ? 'border-slate-800 bg-slate-800/40' : 'border-slate-200 bg-slate-50'
                }`}>
                <div className="mb-3 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-sky-500/15 px-2 py-0.5 text-[11px] font-bold text-sky-600 dark:text-sky-400">
                      Step {currentStep.stepNumber}
                    </span>
                    <span className="font-semibold text-gray-500 dark:text-gray-400">
                      {getFormattedTime(currentStep.timestamp)}
                    </span>
                  </div>
                  <span
                    className={`truncate max-w-[320px] font-mono text-[11px] ${
                      isDarkMode ? 'text-gray-400' : 'text-gray-600'
                    }`}
                    title={currentStep.url || ''}>
                    {currentStep.url || 'browser tab'}
                  </span>
                </div>

                {/* Pipeline Flow Stepper Tabs */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {/* Stage 1: Sanitization */}
                  <div
                    onClick={() => setActiveTab('sanitization')}
                    className={`cursor-pointer rounded-lg border p-2.5 transition-all ${
                      activeTab === 'sanitization'
                        ? isDarkMode
                          ? 'border-emerald-500 bg-emerald-950/40 shadow'
                          : 'border-emerald-400 bg-emerald-50 shadow'
                        : isDarkMode
                          ? 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                      <FiLock size={12} />
                      1. Sanitization
                    </div>
                    <div className="mt-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                      {(currentStep.sanitization?.redactionsCount ?? 0) > 0 ? (
                        <span className="text-emerald-500 font-semibold">
                          {currentStep.sanitization?.redactionsCount} redacted
                        </span>
                      ) : (
                        'Clean page'
                      )}
                    </div>
                  </div>

                  {/* Visual: Images */}
                  <div
                    onClick={() => setActiveTab('images')}
                    className={`cursor-pointer rounded-lg border p-2.5 transition-all ${
                      activeTab === 'images'
                        ? isDarkMode
                          ? 'border-amber-500 bg-amber-950/40 shadow'
                          : 'border-amber-400 bg-amber-50 shadow'
                        : isDarkMode
                          ? 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                      <FiImage size={12} />
                      Images & Vision
                    </div>
                    <div className="mt-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                      {hasSanitizedScreenshot ? (
                        <span className="text-amber-500 font-semibold">Local AI Redacted 📷</span>
                      ) : (
                        'Text-only step'
                      )}
                    </div>
                  </div>

                  {/* Stage 2: Server Outgoing */}
                  <div
                    onClick={() => setActiveTab('outgoing')}
                    className={`cursor-pointer rounded-lg border p-2.5 transition-all ${
                      activeTab === 'outgoing'
                        ? isDarkMode
                          ? 'border-sky-500 bg-sky-950/40 shadow'
                          : 'border-sky-400 bg-sky-50 shadow'
                        : isDarkMode
                          ? 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-600 dark:text-sky-400">
                      <FiSend size={12} />
                      2. Sent to Server
                    </div>
                    <div className="mt-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                      Zero PII payload
                    </div>
                  </div>

                  {/* Stage 3: Server Return */}
                  <div
                    onClick={() => setActiveTab('incoming')}
                    className={`cursor-pointer rounded-lg border p-2.5 transition-all ${
                      activeTab === 'incoming'
                        ? isDarkMode
                          ? 'border-indigo-500 bg-indigo-950/40 shadow'
                          : 'border-indigo-400 bg-indigo-50 shadow'
                        : isDarkMode
                          ? 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                      <FiServer size={12} />
                      3. Return Plan
                    </div>
                    <div className="mt-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                      {currentStep.incoming ? 'Abstract plan' : 'Awaiting plan'}
                    </div>
                  </div>

                  {/* Stage 4: Local Resolve */}
                  <div
                    onClick={() => setActiveTab('local')}
                    className={`cursor-pointer rounded-lg border p-2.5 transition-all ${
                      activeTab === 'local'
                        ? isDarkMode
                          ? 'border-purple-500 bg-purple-950/40 shadow'
                          : 'border-purple-400 bg-purple-50 shadow'
                        : isDarkMode
                          ? 'border-slate-800 bg-slate-900/50 hover:border-slate-700'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-purple-600 dark:text-purple-400">
                      <FiCpu size={12} />
                      4. Local Resolve
                    </div>
                    <div className="mt-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                      {currentStep.localResolution ? (
                        <span className="text-purple-500 font-semibold">Resolved 🔒</span>
                      ) : (
                        'Standard action'
                      )}
                    </div>
                  </div>
                </div>

                {/* View All Button */}
                <div className="mt-2.5 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setActiveTab('all')}
                    className={`text-[11px] font-semibold underline cursor-pointer ${
                      activeTab === 'all'
                        ? 'text-sky-500'
                        : isDarkMode
                          ? 'text-gray-400 hover:text-gray-200'
                          : 'text-gray-600 hover:text-black'
                    }`}>
                    {activeTab === 'all' ? '• Viewing All Stages' : 'Show All Stages Together'}
                  </button>
                </div>
              </div>

              {/* STAGE DETAIL CARDS */}
              <div className="space-y-4">
                {/* 1. Sanitization Card */}
                {(activeTab === 'all' || activeTab === 'sanitization') && (
                  <div
                    className={`rounded-xl border p-4 shadow-sm ${
                      isDarkMode ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white'
                    }`}>
                    <div className="flex items-center justify-between border-b pb-2.5 dark:border-slate-800">
                      <div className="flex items-center gap-2">
                        <span className="flex size-6 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500 font-bold text-xs">
                          1
                        </span>
                        <h4 className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                          Stage 1: Page Sanitization & Redaction
                        </h4>
                      </div>
                      <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                        Local Browser Engine
                      </span>
                    </div>

                    <div className="mt-3 space-y-2 text-xs">
                      <p className={isDarkMode ? 'text-gray-300' : 'text-gray-600'}>
                        {currentStep.sanitization?.summary || 'No summary available.'}
                      </p>

                      {(currentStep.sanitization?.types ?? []).length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          <span className="text-[11px] text-gray-500">Detected Categories:</span>
                          {currentStep.sanitization?.types.map(type => (
                            <span
                              key={type}
                              className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400">
                              {type}
                            </span>
                          ))}
                        </div>
                      )}

                      {(currentStep.sanitization?.sources ?? []).length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          <span className="text-[11px] text-gray-500">Engines Invoked:</span>
                          {currentStep.sanitization?.sources.map(src => (
                            <span
                              key={src}
                              className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400 uppercase">
                              {src === 'vision' ? 'Local ONNX Vision' : src === 'ocr' ? 'Local OCR' : src}
                            </span>
                          ))}
                        </div>
                      )}

                      {(currentStep.sanitization?.sampleRedactions ?? []).length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          <span className="text-[11px] text-gray-500">Redaction Tokens:</span>
                          {currentStep.sanitization?.sampleRedactions?.map(token => (
                            <code
                              key={token}
                              className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-600 dark:text-emerald-400">
                              {token}
                            </code>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 2. Visual / Image Sanitization Card */}
                {(activeTab === 'all' || activeTab === 'sanitization' || activeTab === 'images') && (
                  <div
                    className={`rounded-xl border p-4 shadow-sm ${
                      isDarkMode ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white'
                    }`}>
                    <div className="flex items-center justify-between border-b pb-2.5 dark:border-slate-800">
                      <div className="flex items-center gap-2">
                        <span className="flex size-6 items-center justify-center rounded-full bg-amber-500/10 text-amber-500 font-bold text-xs">
                          📷
                        </span>
                        <h4 className="text-sm font-semibold text-amber-600 dark:text-amber-400">
                          Local Image Sanitization (Screenshots & Vision Models)
                        </h4>
                      </div>
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        Transformers.js & Canvas Redactor
                      </span>
                    </div>

                    <div className="mt-3 space-y-3">
                      {hasSanitizedScreenshot ? (
                        <div>
                          <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                            <div className="flex items-center gap-2 text-xs">
                              <span className="font-semibold text-emerald-500 flex items-center gap-1">
                                <FiCheckCircle size={13} />
                                Sanitized Screenshot:
                              </span>
                              <span className={isDarkMode ? 'text-gray-400' : 'text-gray-500'}>
                                Sensitive pixels blacked out locally before transmission
                              </span>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              {/* Image View Selector */}
                              <div className="flex items-center rounded-lg border p-0.5 text-[11px] dark:border-slate-800">
                                <button
                                  type="button"
                                  onClick={() => setImageViewModel('sanitized')}
                                  className={`rounded px-2 py-0.5 font-medium transition-colors cursor-pointer ${
                                    imageViewModel === 'sanitized'
                                      ? 'bg-amber-600 text-white'
                                      : isDarkMode
                                        ? 'text-gray-400 hover:text-gray-200'
                                        : 'text-gray-600 hover:text-black'
                                  }`}>
                                  Sanitized View
                                </button>
                                {hasRawScreenshot && (
                                  <button
                                    type="button"
                                    onClick={() => setImageViewModel('raw')}
                                    className={`rounded px-2 py-0.5 font-medium transition-colors cursor-pointer ${
                                      imageViewModel === 'raw'
                                        ? 'bg-amber-600 text-white'
                                        : isDarkMode
                                          ? 'text-gray-400 hover:text-gray-200'
                                          : 'text-gray-600 hover:text-black'
                                    }`}>
                                    Original (Device Only)
                                  </button>
                                )}
                                {hasRawScreenshot && (
                                  <button
                                    type="button"
                                    onClick={() => setImageViewModel('comparison')}
                                    className={`rounded px-2 py-0.5 font-medium transition-colors cursor-pointer ${
                                      imageViewModel === 'comparison'
                                        ? 'bg-amber-600 text-white'
                                        : isDarkMode
                                          ? 'text-gray-400 hover:text-gray-200'
                                          : 'text-gray-600 hover:text-black'
                                    }`}>
                                    Side-by-Side
                                  </button>
                                )}
                              </div>

                              {/* Action Tools: Copy & Open */}
                              {sanitizedImg && (
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleCopyImageData(sanitizedImg)}
                                    className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                                      isDarkMode
                                        ? 'border-slate-800 hover:bg-slate-800 text-gray-300'
                                        : 'border-slate-200 hover:bg-gray-100 text-gray-700'
                                    }`}
                                    title="Copy Base64 Data URL to Clipboard">
                                    <FiCopy size={11} />
                                    {copiedDataUrl ? 'Copied!' : 'Copy URL'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenImageInTab(sanitizedImg)}
                                    className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                                      isDarkMode
                                        ? 'border-slate-800 hover:bg-slate-800 text-gray-300'
                                        : 'border-slate-200 hover:bg-gray-100 text-gray-700'
                                    }`}
                                    title="Open Full Resolution in New Tab">
                                    <FiExternalLink size={11} />
                                    Open
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Image Visual Display */}
                          {imageViewModel === 'comparison' && hasRawScreenshot && rawImg && sanitizedImg ? (
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                              <div>
                                <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-rose-500">
                                  <span>Original Webpage (Raw, Never Sent)</span>
                                  <span className="text-[10px] text-gray-500">Unredacted</span>
                                </div>
                                <div
                                  onClick={() => setExpandedImage(rawImg)}
                                  className="relative group cursor-pointer overflow-hidden rounded-lg border dark:border-slate-800 bg-black/40">
                                  <img
                                    src={rawImg}
                                    alt="Original Webpage"
                                    className="h-48 w-full object-contain transition-transform duration-200 group-hover:scale-[1.02]"
                                  />
                                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <span className="flex items-center gap-1 text-xs text-white bg-black/70 px-2 py-1 rounded">
                                      <FiMaximize2 size={12} /> Expand
                                    </span>
                                  </div>
                                </div>
                              </div>

                              <div>
                                <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-emerald-500">
                                  <span>Sanitized Screenshot (Sent to AI)</span>
                                  <span className="text-[10px] text-emerald-400">🛡️ Redacted</span>
                                </div>
                                <div
                                  onClick={() => setExpandedImage(sanitizedImg)}
                                  className="relative group cursor-pointer overflow-hidden rounded-lg border dark:border-slate-800 bg-black/40">
                                  <img
                                    src={sanitizedImg}
                                    alt="Sanitized Webpage"
                                    className="h-48 w-full object-contain transition-transform duration-200 group-hover:scale-[1.02]"
                                  />
                                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <span className="flex items-center gap-1 text-xs text-white bg-black/70 px-2 py-1 rounded">
                                      <FiMaximize2 size={12} /> Expand
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="relative group overflow-hidden rounded-xl border dark:border-slate-800 bg-black/30 text-center">
                              <img
                                src={imageViewModel === 'raw' && rawImg ? rawImg : sanitizedImg || ''}
                                alt="Inspection Screenshot"
                                onClick={() =>
                                  setExpandedImage(imageViewModel === 'raw' && rawImg ? rawImg : sanitizedImg || null)
                                }
                                className="max-h-64 w-full object-contain transition-transform duration-200 cursor-pointer group-hover:scale-[1.01]"
                              />
                              <div
                                onClick={() =>
                                  setExpandedImage(imageViewModel === 'raw' && rawImg ? rawImg : sanitizedImg || null)
                                }
                                className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/80 px-2 py-1 text-[11px] text-white opacity-80 hover:opacity-100 cursor-pointer transition-opacity">
                                <FiMaximize2 size={12} />
                                Click to Expand
                              </div>
                            </div>
                          )}

                          {/* Model Breakdown Pills */}
                          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                            <span className="text-[11px] text-gray-500 font-medium">Local Vision Models:</span>
                            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                              YOLOS-tiny (Transformers.js ONNX)
                            </span>
                            <span className="rounded bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400">
                              OCR Pixel Detector
                            </span>
                            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                              DOM Coordinate Blackout
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div
                          className={`rounded-lg border p-3 text-xs leading-relaxed ${
                            isDarkMode
                              ? 'border-slate-800 bg-slate-950/40 text-gray-400'
                              : 'border-slate-200 bg-gray-50 text-gray-600'
                          }`}>
                          <div className="flex items-center gap-2 font-semibold text-gray-400 mb-1">
                            <FiEye size={14} />
                            Text-Only DOM Sanitization
                          </div>
                          No image screenshot was transmitted to the AI for this step. The agent operated directly on
                          the sanitized DOM interactive element tree, saving bandwidth and ensuring zero visual
                          exposure.
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 3. Outgoing to Server Card */}
                {(activeTab === 'all' || activeTab === 'outgoing') && (
                  <div
                    className={`rounded-xl border p-4 shadow-sm ${
                      isDarkMode ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white'
                    }`}>
                    <div className="flex items-center justify-between border-b pb-2.5 dark:border-slate-800">
                      <div className="flex items-center gap-2">
                        <span className="flex size-6 items-center justify-center rounded-full bg-sky-500/10 text-sky-500 font-bold text-xs">
                          2
                        </span>
                        <h4 className="text-sm font-semibold text-sky-600 dark:text-sky-400">
                          Stage 2: Outgoing to Remote AI Server
                        </h4>
                      </div>
                      <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
                        <FiCheckCircle size={10} />
                        Zero Raw PII Transmitted
                      </span>
                    </div>

                    <div className="mt-3 space-y-2 text-xs">
                      <p className={isDarkMode ? 'text-gray-300' : 'text-gray-600'}>
                        The remote LLM received sanitized interactive elements text with PII tokens redacted. Abstract
                        keys (like <code className="text-sky-500 font-mono font-semibold">profile.email</code>) are
                        transmitted so the model knows your intent, but your actual data never leaves your device.
                      </p>

                      <div
                        className={`rounded-lg border p-2.5 font-mono text-[11px] ${
                          isDarkMode
                            ? 'border-slate-800 bg-slate-950 text-gray-300'
                            : 'border-slate-200 bg-gray-50 text-gray-700'
                        }`}>
                        <div className="mb-1 text-[10px] text-gray-500 font-sans font-medium">
                          Outgoing Text Snippet:
                        </div>
                        <div className="whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                          {currentStep.outgoing?.sanitizedTextPreview || 'No text payload captured.'}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* 4. Return from Server Card */}
                {(activeTab === 'all' || activeTab === 'incoming') && (
                  <div
                    className={`rounded-xl border p-4 shadow-sm ${
                      isDarkMode ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white'
                    }`}>
                    <div className="flex items-center justify-between border-b pb-2.5 dark:border-slate-800">
                      <div className="flex items-center gap-2">
                        <span className="flex size-6 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-500 font-bold text-xs">
                          3
                        </span>
                        <h4 className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">
                          Stage 3: Return from Server (Action Plan)
                        </h4>
                      </div>
                      <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-600 dark:text-indigo-400">
                        Abstract Plan Only
                      </span>
                    </div>

                    <div className="mt-3 space-y-2 text-xs">
                      {currentStep.incoming ? (
                        <>
                          <p className={isDarkMode ? 'text-gray-300' : 'text-gray-600'}>
                            The remote model returned an abstract action. Notice that it does not return real values; it
                            only references data keys:
                          </p>
                          <div
                            className={`rounded-lg border p-2.5 font-mono text-[11px] ${
                              isDarkMode
                                ? 'border-slate-800 bg-slate-950 text-indigo-300'
                                : 'border-slate-200 bg-indigo-50/50 text-indigo-900'
                            }`}>
                            <pre className="whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                              {currentStep.incoming.abstractPlanPreview || 'No plan preview available.'}
                            </pre>
                          </div>
                        </>
                      ) : (
                        <p className="italic text-gray-500">Awaiting server response for this step...</p>
                      )}
                    </div>
                  </div>
                )}

                {/* 5. Local Resolution Card */}
                {(activeTab === 'all' || activeTab === 'local') && (
                  <div
                    className={`rounded-xl border p-4 shadow-sm ${
                      isDarkMode ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white'
                    }`}>
                    <div className="flex items-center justify-between border-b pb-2.5 dark:border-slate-800">
                      <div className="flex items-center gap-2">
                        <span className="flex size-6 items-center justify-center rounded-full bg-purple-500/10 text-purple-500 font-bold text-xs">
                          4
                        </span>
                        <h4 className="text-sm font-semibold text-purple-600 dark:text-purple-400">
                          Stage 4: Local Resolution & Browser Execution
                        </h4>
                      </div>
                      <span className="rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] font-medium text-purple-600 dark:text-purple-400">
                        100% On-Device
                      </span>
                    </div>

                    <div className="mt-3 space-y-2 text-xs">
                      {currentStep.localResolution ? (
                        <>
                          <p className={isDarkMode ? 'text-gray-300' : 'text-gray-600'}>
                            The extension resolved the abstract key directly from the device's secure local store into
                            the browser DOM input field. The real value was never logged or sent to any remote server:
                          </p>
                          <div
                            className={`rounded-lg border p-2.5 ${
                              isDarkMode
                                ? 'border-purple-900/50 bg-purple-950/20 text-purple-300'
                                : 'border-purple-200 bg-purple-50 text-purple-900'
                            }`}>
                            <div className="flex items-center gap-2 font-semibold">
                              <span>🔒 Resolved Keys:</span>
                              <span className="font-mono">
                                {(currentStep.localResolution.resolvedKeys ?? []).join(', ') || 'None'}
                              </span>
                            </div>
                            <div className="mt-1 text-[11px] opacity-90">
                              Status: {currentStep.localResolution.sanitizedMessage || 'Resolved locally.'}
                            </div>
                          </div>
                        </>
                      ) : (
                        <div
                          className={`rounded-lg border p-2.5 ${
                            isDarkMode
                              ? 'border-slate-800 bg-slate-950 text-gray-400'
                              : 'border-slate-200 bg-gray-50 text-gray-600'
                          }`}>
                          Standard browser navigation / click action executed. No local profile credentials required for
                          this step.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div
          className={`flex items-center justify-between border-t px-5 py-3 text-xs ${
            isDarkMode
              ? 'border-slate-800 bg-slate-900/90 text-gray-400'
              : 'border-slate-100 bg-slate-50/90 text-gray-500'
          }`}>
          <div className="flex items-center gap-2">
            <FiLock size={12} className="text-emerald-500" />
            <span>Local privacy protection active • Data stored locally only</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-sky-600 px-4 py-1.5 font-semibold text-white shadow-sm hover:bg-sky-500 transition-colors cursor-pointer">
            Done
          </button>
        </div>

        {/* Expanded Image Modal Overlay */}
        {expandedImage && (
          <div
            className="fixed inset-0 z-60 flex items-center justify-center bg-black/90 p-4"
            onClick={() => setExpandedImage(null)}>
            <div className="relative max-h-[90vh] max-w-[90vw] overflow-hidden rounded-xl border border-slate-700 bg-black">
              <button
                type="button"
                onClick={() => setExpandedImage(null)}
                className="absolute top-3 right-3 rounded-full bg-black/70 p-2 text-white hover:bg-black cursor-pointer">
                <FiX size={20} />
              </button>
              <img src={expandedImage} alt="Expanded Screenshot" className="max-h-[85vh] max-w-[85vw] object-contain" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PrivacyFlowModal;
