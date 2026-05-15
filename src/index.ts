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
  DEFAULT_DISPLAY_UPDATE_INTERVAL_MS,
  type TimerScheduler,
} from "./checkpoints.js";
import {
  createTldrState,
  registerTldrExtension,
  type PiTldrDependencies,
} from "./extension.js";

export type { PiTldrDependencies, TimerScheduler };

/** Returns the production monotonic time for TLDR scheduling. */
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
  const displayUpdateIntervalMs = Math.max(
    0,
    dependencies.displayUpdateIntervalMs ??
      dependencies.toolActivityCoalesceMs ??
      DEFAULT_DISPLAY_UPDATE_INTERVAL_MS,
  );
  const scheduler = dependencies.scheduler ?? createDefaultTimerScheduler();

  /** Registers this extension instance with pi. */
  return (pi: ExtensionAPI): void => {
    const state = createTldrState(
      generateTldr,
      now,
      displayUpdateIntervalMs,
      scheduler,
    );

    registerTldrExtension(pi, state);
  };
}

/** Default pi-tldr extension instance used by pi's package loader. */
export const piTldr = createPiTldr();

/** pi's extension loader expects package extensions to provide a default export. */
export default piTldr;
