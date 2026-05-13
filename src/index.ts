/**
 * @fileoverview Package entry point for the pi-tldr extension.
 *
 * This module exposes the default pi extension factory and the testable
 * `createPiTldr` constructor that wires production dependencies into the
 * extension registration layer.
 */
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createDefaultTimerScheduler,
  createTldrState,
  DEFAULT_TOOL_ACTIVITY_COALESCE_MS,
  PiTldrDependencies,
  registerTldrExtension,
  TimerScheduler,
} from "./extension.js";

export { PiTldrDependencies, TimerScheduler };

/** Returns the current high-resolution time for TLDR scheduling. */
function defaultTldrClock(): number {
  return performance.now();
}

/**
 * Creates a pi-tldr extension instance.
 *
 * @param dependencies Optional test seams for model calls, clocks, and timers.
 * @returns A pi extension registration function.
 */
export function createPiTldr(
  dependencies: PiTldrDependencies = {},
): (pi: ExtensionAPI) => void {
  const generateTldr = dependencies.generateTldr ?? complete;
  const now = dependencies.now ?? defaultTldrClock;
  const toolActivityCoalesceMs = Math.max(
    0,
    dependencies.toolActivityCoalesceMs ?? DEFAULT_TOOL_ACTIVITY_COALESCE_MS,
  );
  const scheduler = dependencies.scheduler ?? createDefaultTimerScheduler();

  /** Registers this extension instance with pi. */
  return (pi: ExtensionAPI): void => {
    const state = createTldrState(
      generateTldr,
      now,
      toolActivityCoalesceMs,
      scheduler,
    );

    registerTldrExtension(pi, state);
  };
}

/** Default pi-tldr extension instance used by pi's package loader. */
export const piTldr = createPiTldr();

/** pi's extension loader expects package extensions to provide a default export. */
export default piTldr;
