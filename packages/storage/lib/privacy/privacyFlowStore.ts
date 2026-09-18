import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';
import type { BaseStorage } from '../base/types';

export interface PrivacyStageSanitization {
  sensitiveCount: number;
  types: string[]; // e.g. ['EMAIL', 'PASSWORD', 'PHONE', 'FACE', 'PERSON']
  sources: string[]; // e.g. ['dom', 'regex', 'vision', 'ocr']
  redactionsCount: number;
  summary: string;
  sampleRedactions?: string[];
  screenshotRedacted?: boolean;
  sanitizedScreenshot?: string | null; // Data URL of screenshot with sensitive areas redacted by local models
  rawScreenshot?: string | null; // Data URL of raw screenshot before redaction (kept on-device only)
  visionRegionsCount?: number;
  ocrRegionsCount?: number;
  domRegionsCount?: number;
}

export interface PrivacyStageOutgoing {
  modelName: string;
  provider: string;
  charCount: number;
  sanitizedTextPreview: string;
  hasScreenshot: boolean;
  dataKeysIncluded: string[];
}

export interface PrivacyStageIncoming {
  actionName?: string;
  abstractPlanPreview: string;
  dataKeysUsed?: string[];
}

export interface PrivacyStageLocalResolution {
  resolvedKeys: string[];
  elementIndex?: number;
  sanitizedMessage: string;
  timestamp: number;
}

export interface PrivacyFlowStepRecord {
  stepId: string;
  stepNumber: number;
  taskId: string;
  timestamp: number;
  url: string;
  title: string;
  sanitization: PrivacyStageSanitization;
  outgoing: PrivacyStageOutgoing;
  incoming?: PrivacyStageIncoming;
  localResolution?: PrivacyStageLocalResolution;
}

export interface PrivacyFlowState {
  steps: PrivacyFlowStepRecord[];
  totalRedactionsCount: number;
  activeStepId: string | null;
  lastUpdated: number;
}

export const DEFAULT_PRIVACY_FLOW_STATE: PrivacyFlowState = {
  steps: [],
  totalRedactionsCount: 0,
  activeStepId: null,
  lastUpdated: Date.now(),
};

const MAX_RECORDS = 20;

const storage = createStorage<PrivacyFlowState>('privacy-flow-state', DEFAULT_PRIVACY_FLOW_STATE, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type PrivacyFlowStore = BaseStorage<PrivacyFlowState> & {
  addStep: (stepData: Omit<PrivacyFlowStepRecord, 'stepId' | 'timestamp'>) => Promise<string>;
  updateStepIncoming: (stepNumber: number, incoming: PrivacyStageIncoming, taskId?: string) => Promise<void>;
  updateStepResolution: (stepNumber: number, resolution: PrivacyStageLocalResolution, taskId?: string) => Promise<void>;
  getLatest: () => Promise<PrivacyFlowStepRecord | null>;
  clear: () => Promise<void>;
};

export const privacyFlowStore: PrivacyFlowStore = {
  ...storage,

  async addStep(stepData) {
    const stepId = `step_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newRecord: PrivacyFlowStepRecord = {
      ...stepData,
      stepId,
      timestamp: Date.now(),
    };

    try {
      console.log(`🛡️ [PRIVACY STORE] Step ${newRecord.stepNumber} saved to storage:`, {
        taskId: newRecord.taskId,
        hasSanitizedScreenshot: Boolean(newRecord.sanitization?.sanitizedScreenshot),
        hasRawScreenshot: Boolean(newRecord.sanitization?.rawScreenshot),
        redactionsCount: newRecord.sanitization?.redactionsCount,
      });
    } catch {
      // ignore
    }

    await storage.set(prev => {
      const state = prev || DEFAULT_PRIVACY_FLOW_STATE;
      const rawSteps = Array.isArray(state.steps) ? state.steps : [];
      // Deduplicate only if exact same task and stepNumber
      const filtered = rawSteps.filter(
        s => Boolean(s) && !(s.taskId === newRecord.taskId && s.stepNumber === newRecord.stepNumber),
      );
      const steps = [...filtered, newRecord]
        .sort((a, b) => (a?.timestamp || 0) - (b?.timestamp || 0))
        .slice(-MAX_RECORDS);
      const totalRedactionsCount = steps.reduce((acc, s) => acc + (s?.sanitization?.redactionsCount || 0), 0);

      return {
        steps,
        totalRedactionsCount,
        activeStepId: stepId,
        lastUpdated: Date.now(),
      };
    });

    return stepId;
  },

  async updateStepIncoming(stepNumber, incoming, taskId) {
    await storage.set(prev => {
      if (!prev || !Array.isArray(prev.steps) || prev.steps.length === 0) return DEFAULT_PRIVACY_FLOW_STATE;

      let targetIndex = -1;
      if (taskId) {
        targetIndex = prev.steps.findIndex(s => s && s.taskId === taskId && s.stepNumber === stepNumber);
      }
      if (targetIndex === -1) {
        for (let i = prev.steps.length - 1; i >= 0; i--) {
          if (prev.steps[i] && prev.steps[i].stepNumber === stepNumber) {
            targetIndex = i;
            break;
          }
        }
      }
      if (targetIndex === -1) return prev;

      const steps = [...prev.steps];
      steps[targetIndex] = {
        ...steps[targetIndex],
        incoming,
      };

      return {
        ...prev,
        steps,
        lastUpdated: Date.now(),
      };
    });
  },

  async updateStepResolution(stepNumber, resolution, taskId) {
    await storage.set(prev => {
      if (!prev || !Array.isArray(prev.steps) || prev.steps.length === 0) return DEFAULT_PRIVACY_FLOW_STATE;

      let targetIndex = -1;
      if (taskId) {
        targetIndex = prev.steps.findIndex(s => s && s.taskId === taskId && s.stepNumber === stepNumber);
      }
      if (targetIndex === -1) {
        for (let i = prev.steps.length - 1; i >= 0; i--) {
          if (prev.steps[i] && prev.steps[i].stepNumber === stepNumber) {
            targetIndex = i;
            break;
          }
        }
      }
      if (targetIndex === -1) return prev;

      const steps = [...prev.steps];
      steps[targetIndex] = {
        ...steps[targetIndex],
        localResolution: resolution,
      };

      return {
        ...prev,
        steps,
        lastUpdated: Date.now(),
      };
    });
  },

  async getLatest() {
    const state = await storage.get();
    if (!state || !Array.isArray(state.steps) || state.steps.length === 0) return null;
    return state.steps[state.steps.length - 1];
  },

  async clear() {
    await storage.set(DEFAULT_PRIVACY_FLOW_STATE);
  },
};
