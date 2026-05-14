/**
 * @fileoverview pi extension integration, command handling, and TLDR flow.
 *
 * This module is the readable orchestration layer for pi-tldr. It registers the
 * `/tldr` command, listens to pi session/activity events, records indexed
 * activity, generates rolling TLDR checkpoints, ignores stale async work, and
 * renders the widget. Leaf modules handle fact extraction, model lookup, text
 * extraction, and TUI drawing; the event-to-TLDR flow stays here.
 */
import { complete } from "@earendil-works/pi-ai";
import type { UserMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  extractTextContent,
  TldrFactCollector,
  type TldrActivity,
  type TldrDisplayPriority,
} from "./facts.js";
import {
  formatAuthModelKey,
  formatModelPreference,
  getFastModelAuth,
  resolveInitialModelPreference,
  type TldrModelPreference,
} from "./models.js";
import { clearWidget, notifyUser, showWidget } from "./tui.js";

const DISPLAY_UPDATE_INTERVAL_MS = 1_200;
const PROMPT_TARGET_SUMMARY_CHARS = 80;
const MAX_CONTEXT_CHECKPOINTS = 8;
const TLDR_MAX_TOKENS = 120;
const TLDR_REQUEST_TIMEOUT_MS = 1_800;

/** Default interval used to throttle ordinary widget display updates. */
export const DEFAULT_DISPLAY_UPDATE_INTERVAL_MS = DISPLAY_UPDATE_INTERVAL_MS;

const TLDR_SYSTEM_PROMPT_PREFIX = `You write live status TLDRs for a terminal coding agent.
Return one short, complete, plain-English sentence under ${PROMPT_TARGET_SUMMARY_CHARS} characters.
The sentence must be complete and must not trail off.
Describe what the agent is doing right now for the user's task.
Use previous generated TLDR checkpoints as compressed context.
Use new raw activity to update the status through the requested activity.`;

const TLDR_SYSTEM_PROMPT_SUFFIX = `Do not use first person.
Do not address the user directly.
Do not speak as the assistant.
Do not output JSON, markdown, code, logs, diffs, XML, bullet points, or quoted strings.
Do not mention tool names, command names, raw arguments, or individual file names.
Output only the TLDR sentence.`;

const IN_PROGRESS_TLDR_INSTRUCTION =
  "Start with a present-tense action verb form ending in -ing.";
const FINAL_TLDR_INSTRUCTION = "Start with a past-tense action verb.";

/** Function shape used to call the model that writes TLDR text. */
export type TldrModelCall = typeof complete;
/** Function shape used to read monotonic time for TLDR scheduling. */
export type TldrClock = () => number;

/** Timer boundary used to make TLDR scheduling deterministic in tests. */
export interface TimerScheduler {
  /** Schedules a callback after the requested delay. */
  setTimeout(callback: () => void, delayMs: number): unknown;
  /** Cancels a timer returned by {@link setTimeout}. */
  clearTimeout(handle: unknown): void;
}

/** Optional dependency overrides for constructing a pi-tldr extension instance. */
export interface PiTldrDependencies {
  /** Model call used to ask the TLDR model for text. */
  readonly generateTldr?: TldrModelCall;
  /** Monotonic clock used for TLDR scheduling decisions. */
  readonly now?: TldrClock;
  /** Interval used to throttle ordinary widget display updates. */
  readonly displayUpdateIntervalMs?: number;
  /** Deprecated compatibility alias for the old generation coalescing seam. */
  readonly toolActivityCoalesceMs?: number;
  /** Timer scheduler; overridden by tests for deterministic execution. */
  readonly scheduler?: TimerScheduler;
}

interface TldrCheckpointJob {
  readonly activityIndex: number;
  readonly displayPriority: TldrDisplayPriority;
  readonly runId: number;
}

interface TldrCheckpoint {
  readonly activityIndex: number;
  readonly displayPriority: TldrDisplayPriority;
  readonly text: string;
}

interface TldrWorkState {
  runId: number;
  latestAcceptedActivityIndex: number;
  lastRenderedActivityIndex: number;
  lastRenderedTldr: string;
  lastDisplayAt: number;
  checkpointQueue: TldrCheckpointJob[];
  acceptedCheckpoints: TldrCheckpoint[];
  inFlightCheckpoint?: TldrCheckpointJob;
  pendingDisplayCheckpoint?: TldrCheckpoint;
  displayTimer?: unknown;
  abortController?: AbortController;
}

/** Mutable state for one loaded pi-tldr extension instance. */
export interface TldrState {
  /** Whether the current pi session should accept activity events. */
  sessionActive: boolean;
  /** Model configured through pi settings, or undefined for automatic selection. */
  configuredModel?: TldrModelPreference;
  /** Activity collector for the current conversation. */
  readonly facts: TldrFactCollector;
  /** TLDR checkpoint/model-call state. Kept together to make invariants local. */
  readonly tldr: TldrWorkState;
  /** Model call used for TLDRs. */
  readonly generateTldr: TldrModelCall;
  /** Monotonic clock used by TLDR scheduling. */
  readonly now: TldrClock;
  /** Interval used to throttle ordinary widget display updates. */
  readonly displayUpdateIntervalMs: number;
  /** Timer scheduler used by TLDR scheduling. */
  readonly scheduler: TimerScheduler;
}

/** Creates the production timer scheduler backed by Node timers. */
export function createDefaultTimerScheduler(): TimerScheduler {
  return {
    /** Schedules TLDR work with Node's timer API. */
    setTimeout(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    /** Cancels TLDR work scheduled with Node's timer API. */
    clearTimeout(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

/** Creates the mutable state object for a loaded pi-tldr extension. */
export function createTldrState(
  generateTldr: TldrModelCall,
  now: TldrClock,
  displayUpdateIntervalMs: number,
  scheduler: TimerScheduler,
): TldrState {
  return {
    sessionActive: false,
    facts: new TldrFactCollector(),
    tldr: {
      runId: 0,
      latestAcceptedActivityIndex: 0,
      lastRenderedActivityIndex: 0,
      lastRenderedTldr: "",
      lastDisplayAt: Number.NEGATIVE_INFINITY,
      checkpointQueue: [],
      acceptedCheckpoints: [],
    },
    generateTldr,
    now,
    displayUpdateIntervalMs,
    scheduler,
  };
}

/** Registers the `/tldr` command and routes subcommands. */
function registerTldrCommand(pi: ExtensionAPI, state: TldrState): void {
  pi.registerCommand("tldr", {
    description: "pi-tldr status",
    /** Handles `/tldr`, `/tldr help`, and `/tldr status`. */
    handler: async (args, ctx) => {
      const action = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

      if (!action || action === "help") {
        notifyUser(
          ctx,
          [
            "pi-tldr commands",
            "/tldr help - show this help",
            "/tldr status - show selected and active model status",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (action === "status") {
        await notifyTldrStatus(ctx, state);
        return;
      }

      notifyUser(ctx, "Use /tldr [help|status]", "error");
    },
  });
}

/** Shows the selected settings model and the currently usable fallback model. */
async function notifyTldrStatus(
  ctx: ExtensionContext,
  state: TldrState,
): Promise<void> {
  // Snapshot the selected model before auth lookup so status reports the model
  // active when the command was invoked, not after a possible session switch.
  const configuredModel = state.configuredModel;
  const selectedModelLine = `selected model: ${formatModelPreference(configuredModel)}`;
  let activeModelLine: string;

  try {
    const auth = await getFastModelAuth(ctx, configuredModel);
    activeModelLine = auth
      ? `active model: ${formatAuthModelKey(auth)}`
      : "active model: none";
  } catch {
    activeModelLine = "active model: unknown (auth check failed)";
  }

  notifyUser(
    ctx,
    ["pi-tldr status", selectedModelLine, activeModelLine].join("\n"),
    "info",
  );
}

/** Registers pi lifecycle and activity handlers that feed TLDRs. */
function registerTldrLifecycleHandlers(
  pi: ExtensionAPI,
  state: TldrState,
): void {
  // Starts a fresh pi session and invalidates any stale TLDR work.
  pi.on("session_start", (_event, ctx) => {
    state.sessionActive = true;
    state.configuredModel = resolveInitialModelPreference(ctx.cwd);
    state.facts.resetConversation();
    startFreshTldrRun(state);
    clearWidget(ctx);
  });

  // Ends the current session and prevents pending TLDR work from rendering.
  pi.on("session_shutdown", (_event, ctx) => {
    state.sessionActive = false;
    state.facts.resetConversation();
    startFreshTldrRun(state);
    clearWidget(ctx);
  });

  // Records a user prompt as a new conversation activity boundary.
  pi.on("before_agent_start", (event, ctx) => {
    if (!state.sessionActive) return;

    const activity = state.facts.recordUserMessage(event.prompt);
    clearWidget(ctx);
    clearPendingDisplay(state);
    state.tldr.lastRenderedTldr = "";
    enqueueCheckpoint(ctx, state, activity);
  });

  // Records streaming assistant progress as normal TLDR activity.
  pi.on("message_update", (event, ctx) => {
    if (!state.sessionActive) return;

    const activity = state.facts.recordAssistantUpdate(event.message);
    if (activity) enqueueCheckpoint(ctx, state, activity);
  });

  // Records the beginning of tool activity.
  pi.on("tool_call", (event, ctx) => {
    if (!state.sessionActive) return;

    enqueueCheckpoint(ctx, state, state.facts.recordToolCall(event));
  });

  // Records the result of tool activity.
  pi.on("tool_result", (event, ctx) => {
    if (!state.sessionActive) return;

    enqueueCheckpoint(ctx, state, state.facts.recordToolResult(event));
  });

  // Records final assistant output or clears stale TLDR state for empty output.
  pi.on("message_end", (event, ctx) => {
    if (!state.sessionActive) return;

    const result = state.facts.recordMessageEnd(event.message);
    if (result === "ignored") return;

    if (result === "emptyFinalStop") {
      state.facts.resetConversation();
      startFreshTldrRun(state);
      clearWidget(ctx);
      return;
    }

    enqueueCheckpoint(ctx, state, result);
  });
}

/** Starts a new conversation-level TLDR run and invalidates stale model work. */
function startFreshTldrRun(state: TldrState): void {
  state.tldr.runId++;
  discardCurrentTldr(state);
}

/** Clears all TLDR state for a run that should no longer show a TLDR. */
function discardCurrentTldr(state: TldrState): void {
  cancelCheckpointWork(state);
  state.tldr.latestAcceptedActivityIndex = 0;
  state.tldr.lastRenderedActivityIndex = 0;
  state.tldr.lastRenderedTldr = "";
  state.tldr.lastDisplayAt = Number.NEGATIVE_INFINITY;
  state.tldr.acceptedCheckpoints.splice(0);
  state.tldr.pendingDisplayCheckpoint = undefined;
}

/** Cancels queued and in-flight checkpoint work. */
function cancelCheckpointWork(state: TldrState): void {
  clearDisplayTimer(state);
  state.tldr.checkpointQueue.splice(0);
  state.tldr.inFlightCheckpoint = undefined;
  state.tldr.abortController?.abort();
  state.tldr.abortController = undefined;
}

/** Cancels the pending display timer, if one exists. */
function clearDisplayTimer(state: TldrState): void {
  if (state.tldr.displayTimer === undefined) return;

  state.scheduler.clearTimeout(state.tldr.displayTimer);
  state.tldr.displayTimer = undefined;
}

/** Removes queued normal checkpoints that have been superseded. */
function removeQueuedNormalCheckpoints(state: TldrState): void {
  state.tldr.checkpointQueue = state.tldr.checkpointQueue.filter(
    (job) => job.displayPriority !== "normal",
  );
}

/** Replaces any queued normal checkpoint with the newest normal target. */
function replaceQueuedNormalCheckpoint(
  state: TldrState,
  job: TldrCheckpointJob,
): void {
  removeQueuedNormalCheckpoints(state);
  state.tldr.checkpointQueue.push(job);
}

/** Aborts the current in-flight checkpoint request, if one exists. */
function abortInFlightCheckpoint(state: TldrState): void {
  if (!state.tldr.inFlightCheckpoint) return;

  state.tldr.abortController?.abort();
  state.tldr.abortController = undefined;
  state.tldr.inFlightCheckpoint = undefined;
}

/** Aborts in-flight normal work when a boundary checkpoint supersedes it. */
function abortInFlightNormalCheckpoint(state: TldrState): void {
  const inFlight = state.tldr.inFlightCheckpoint;
  if (!inFlight || inFlight.displayPriority !== "normal") return;

  abortInFlightCheckpoint(state);
}

/** Enqueues a checkpoint generation job for one recorded activity. */
function enqueueCheckpoint(
  ctx: ExtensionContext,
  state: TldrState,
  activity: TldrActivity,
): void {
  if (!ctx.hasUI || !state.sessionActive) return;

  const job = {
    activityIndex: activity.index,
    displayPriority: activity.displayPriority,
    runId: state.tldr.runId,
  } satisfies TldrCheckpointJob;

  if (job.displayPriority === "immediate") {
    clearPendingDisplay(state);
    state.tldr.checkpointQueue.splice(0);
    abortInFlightCheckpoint(state);
    state.tldr.checkpointQueue.push(job);
  } else if (job.displayPriority === "final") {
    clearPendingDisplay(state);
    removeQueuedNormalCheckpoints(state);
    abortInFlightNormalCheckpoint(state);
    state.tldr.checkpointQueue.push(job);
  } else {
    replaceQueuedNormalCheckpoint(state, job);
  }

  pumpCheckpointGeneration(ctx, state);
}

/** Starts the next checkpoint model call if the generation pump is idle. */
function pumpCheckpointGeneration(
  ctx: ExtensionContext,
  state: TldrState,
): void {
  if (!ctx.hasUI || !state.sessionActive || state.tldr.inFlightCheckpoint) {
    return;
  }

  const job = state.tldr.checkpointQueue.shift();
  if (!job) return;
  if (job.runId !== state.tldr.runId) {
    pumpCheckpointGeneration(ctx, state);
    return;
  }
  if (job.activityIndex <= state.tldr.latestAcceptedActivityIndex) {
    pumpCheckpointGeneration(ctx, state);
    return;
  }

  state.tldr.inFlightCheckpoint = job;
  void runCheckpointRequest(ctx, state, job);
}

/** Returns whether queued or in-flight checkpoint work still belongs here. */
function isCurrentCheckpointJob(
  state: TldrState,
  job: TldrCheckpointJob,
): boolean {
  return (
    state.sessionActive &&
    job.runId === state.tldr.runId &&
    state.tldr.inFlightCheckpoint === job
  );
}

/** Calls the TLDR model and accepts its generated checkpoint if still current. */
async function runCheckpointRequest(
  ctx: ExtensionContext,
  state: TldrState,
  job: TldrCheckpointJob,
): Promise<void> {
  if (!isCurrentCheckpointJob(state, job)) return;

  let abortController: AbortController | undefined;

  try {
    const prompt = checkpointPrompt(state, job);
    if (!prompt) return;

    const auth = await getFastModelAuth(ctx, state.configuredModel);
    if (!isCurrentCheckpointJob(state, job) || !auth) return;

    abortController = new AbortController();
    state.tldr.abortController = abortController;

    const response = await state.generateTldr(
      auth.model,
      {
        systemPrompt: checkpointSystemPrompt(job),
        messages: [prompt],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: TLDR_MAX_TOKENS,
        maxRetries: 0,
        cacheRetention: "none",
        timeoutMs: TLDR_REQUEST_TIMEOUT_MS,
        signal: abortController.signal,
      },
    );

    if (!isCurrentCheckpointJob(state, job)) return;
    if (response.stopReason !== "stop") return;

    const text = extractTextContent(response.content) ?? "";
    if (!text) return;

    const checkpoint = {
      activityIndex: job.activityIndex,
      displayPriority: job.displayPriority,
      text,
    } satisfies TldrCheckpoint;

    acceptCheckpoint(state, checkpoint);
    considerDisplayingCheckpoint(ctx, state, checkpoint);
  } catch {
    // TLDRs are best-effort; later checkpoints include unaccepted raw activity.
  } finally {
    if (abortController && state.tldr.abortController === abortController) {
      state.tldr.abortController = undefined;
    }
    if (state.tldr.inFlightCheckpoint === job) {
      state.tldr.inFlightCheckpoint = undefined;
    }
    pumpCheckpointGeneration(ctx, state);
  }
}

/** Accepts a generated checkpoint as compressed context for future prompts. */
function acceptCheckpoint(state: TldrState, checkpoint: TldrCheckpoint): void {
  state.tldr.acceptedCheckpoints.push(checkpoint);
  if (state.tldr.acceptedCheckpoints.length > MAX_CONTEXT_CHECKPOINTS) {
    state.tldr.acceptedCheckpoints.splice(
      0,
      state.tldr.acceptedCheckpoints.length - MAX_CONTEXT_CHECKPOINTS,
    );
  }
  state.tldr.latestAcceptedActivityIndex = checkpoint.activityIndex;
  state.facts.discardActivitiesThrough(checkpoint.activityIndex);
}

/** Clears any delayed normal checkpoint waiting for display. */
function clearPendingDisplay(state: TldrState): void {
  clearDisplayTimer(state);
  state.tldr.pendingDisplayCheckpoint = undefined;
}

/** Applies display policy to an accepted generated checkpoint. */
function considerDisplayingCheckpoint(
  ctx: ExtensionContext,
  state: TldrState,
  checkpoint: TldrCheckpoint,
): void {
  if (checkpoint.activityIndex <= state.tldr.lastRenderedActivityIndex) return;
  if (checkpoint.activityIndex !== state.facts.latestActivityIndex()) return;

  if (checkpoint.displayPriority !== "normal" || !state.tldr.lastRenderedTldr) {
    clearPendingDisplay(state);
    renderCheckpoint(ctx, state, checkpoint);
    return;
  }

  const elapsedMs = state.now() - state.tldr.lastDisplayAt;
  if (elapsedMs >= state.displayUpdateIntervalMs) {
    clearPendingDisplay(state);
    renderCheckpoint(ctx, state, checkpoint);
    return;
  }

  state.tldr.pendingDisplayCheckpoint = checkpoint;
  if (state.tldr.displayTimer !== undefined) return;

  state.tldr.displayTimer = state.scheduler.setTimeout(() => {
    state.tldr.displayTimer = undefined;
    const pendingCheckpoint = state.tldr.pendingDisplayCheckpoint;
    state.tldr.pendingDisplayCheckpoint = undefined;
    if (!pendingCheckpoint || !state.sessionActive) return;
    if (pendingCheckpoint.activityIndex !== state.facts.latestActivityIndex()) {
      return;
    }

    renderCheckpoint(ctx, state, pendingCheckpoint);
  }, state.displayUpdateIntervalMs - elapsedMs);
}

/** Renders an accepted checkpoint. */
function renderCheckpoint(
  ctx: ExtensionContext,
  state: TldrState,
  checkpoint: TldrCheckpoint,
): void {
  if (checkpoint.activityIndex <= state.tldr.lastRenderedActivityIndex) return;
  if (checkpoint.text === state.tldr.lastRenderedTldr) return;

  state.tldr.lastRenderedActivityIndex = checkpoint.activityIndex;
  state.tldr.lastRenderedTldr = checkpoint.text;
  state.tldr.lastDisplayAt = state.now();
  showWidget(ctx, checkpoint.text);
}

/** Builds the system prompt sent to the TLDR model for a checkpoint. */
function checkpointSystemPrompt(job: TldrCheckpointJob): string {
  const tenseInstruction =
    job.displayPriority === "final"
      ? FINAL_TLDR_INSTRUCTION
      : IN_PROGRESS_TLDR_INSTRUCTION;

  return [
    TLDR_SYSTEM_PROMPT_PREFIX,
    tenseInstruction,
    TLDR_SYSTEM_PROMPT_SUFFIX,
  ].join("\n");
}

/** Builds the single user message sent to the TLDR model for a checkpoint. */
function checkpointPrompt(
  state: TldrState,
  job: TldrCheckpointJob,
): UserMessage | undefined {
  const rawActivities = state.facts.activitiesAfter(
    state.tldr.latestAcceptedActivityIndex,
    job.activityIndex,
  );
  if (rawActivities.length === 0) return undefined;

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "Previous generated TLDR checkpoints:",
          previousCheckpointLines(state.tldr.acceptedCheckpoints),
          "",
          "New raw activity since the latest accepted checkpoint:",
          ...rawActivities.map(formatRawActivity),
          "",
          `Write the next TLDR through activity ${job.activityIndex}.`,
        ].join("\n"),
      },
    ],
    timestamp: Date.now(),
  };
}

/** Formats accepted checkpoints as compressed prompt context. */
function previousCheckpointLines(
  checkpoints: readonly TldrCheckpoint[],
): string {
  if (checkpoints.length === 0) return "none";

  return checkpoints
    .slice(-MAX_CONTEXT_CHECKPOINTS)
    .map(
      (checkpoint) =>
        `- Through activity ${checkpoint.activityIndex}: ${checkpoint.text}`,
    )
    .join("\n");
}

/** Formats a raw activity record for the checkpoint prompt. */
function formatRawActivity(activity: TldrActivity): string {
  return `[${activity.index}] ${activity.activityType}: ${activity.text}`;
}

/**
 * Registers all pi-tldr commands and event handlers with pi.
 *
 * @param pi pi extension API supplied by the package loader.
 * @param state Mutable extension state created by {@link createTldrState}.
 */
export function registerTldrExtension(
  pi: ExtensionAPI,
  state: TldrState,
): void {
  registerTldrCommand(pi, state);
  registerTldrLifecycleHandlers(pi, state);
}
