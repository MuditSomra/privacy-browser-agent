/**
 * privacy-engine/core/logger.ts
 *
 * Minimal console-based logger so the engine never depends on NanoBrowser's
 * `@src/background/log`. An adapter is free to bridge these to a host logger.
 */
export interface EngineLogger {
  info(msg: string, ...args: unknown[]): void;
  warning(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

function makeLogger(namespace: string): EngineLogger {
  return {
    info: (msg, ...args) => console.info(`[${namespace}]`, msg, ...args),
    warning: (msg, ...args) => console.warn(`[${namespace}]`, msg, ...args),
    error: (msg, ...args) => console.error(`[${namespace}]`, msg, ...args),
  };
}

export const createEngineLogger = makeLogger;
