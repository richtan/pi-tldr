/**
 * @fileoverview Package entry point for the pi-tldr extension.
 *
 * This module exposes the default pi extension factory and the testable
 * `createPiTldr` constructor that wires production dependencies into the
 * extension registration layer.
 */
import { complete } from "@earendil-works/pi-ai/compat";
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

function defaultTldrClock(): number {
  return performance.now();
}

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

export const piTldr = createPiTldr();

// pi loads package extensions through the package default export.
export default piTldr;
