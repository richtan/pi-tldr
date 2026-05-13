/**
 * @fileoverview pi extension integration, command handling, and TLDR flow.
 *
 * This module is the readable orchestration layer for pi-tldr. It registers the
 * `/tldr` command, listens to pi session/activity events, records raw facts,
 * schedules TLDR model calls, ignores stale async work, and renders the widget.
 * Leaf modules handle fact extraction, model lookup, text extraction, and TUI
 * drawing; the event-to-TLDR flow stays here.
 */
import { complete, UserMessage } from "@mariozechner/pi-ai";
import { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { extractTextContent, TldrFactCollector } from "./facts.js";
import {
  formatAuthModelKey,
  formatModelPreference,
  getFastModelAuth,
  resolveInitialModelPreference,
  TldrModelPreference,
} from "./models.js";
import { clearWidget, notifyUser, showWidget } from "./tui.js";

const MODEL_UPDATE_INTERVAL_MS = 1_200;
const PROMPT_TARGET_SUMMARY_CHARS = 80;
const TLDR_MAX_TOKENS = 120;
const TLDR_REQUEST_TIMEOUT_MS = 3_000;

/** Default delay used to group quick tool call/result bursts into one TLDR. */
export const DEFAULT_TOOL_ACTIVITY_COALESCE_MS = 300;

const TLDR_SYSTEM_PROMPT = `You write live status TLDRs for a terminal coding agent.
Return one short, complete, plain-English sentence under ${PROMPT_TARGET_SUMMARY_CHARS} characters.
The sentence must be complete and must not trail off.
Describe what the agent is doing right now for the user's task.
Prioritize the latest event facts; use earlier facts only as context.
For in-progress work, start with a present-tense action verb form ending in -ing.
For final results or completed work, start with a past-tense action verb.
Do not use first person.
Do not address the user directly.
Do not speak as the assistant.
Do not output JSON, markdown, code, logs, diffs, XML, bullet points, or quoted strings.
Do not mention tool names, command names, raw arguments, or individual file names.
Output only the TLDR sentence.`;

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
  /** Delay used to coalesce rapid tool activity into one TLDR request. */
  readonly toolActivityCoalesceMs?: number;
  /** Timer scheduler; overridden by tests for deterministic execution. */
  readonly scheduler?: TimerScheduler;
}

/** How urgently a fact snapshot should be sent to the TLDR model. */
type TldrUrgency = "now" | "throttled" | "coalesced";

interface QueuedTldr {
  readonly snapshot: string;
  readonly configuredModel?: TldrModelPreference;
  readonly runId: number;
  readonly requestId: number;
}

interface TldrWorkState {
  runId: number;
  requestId: number;
  lastSubmittedFacts: string;
  lastRenderedTldr: string;
  lastTldrStartedAt: number;
  queuedTldr?: QueuedTldr;
  updateTimer?: unknown;
  abortController?: AbortController;
}

/** Mutable state for one loaded pi-tldr extension instance. */
export interface TldrState {
  /** Whether the current pi session should accept activity events. */
  sessionActive: boolean;
  /** Model configured through pi settings, or undefined for automatic selection. */
  configuredModel?: TldrModelPreference;
  /** Fact collector for the current agent run. */
  readonly facts: TldrFactCollector;
  /** TLDR scheduling/model-call state. Kept together to make invariants local. */
  readonly tldr: TldrWorkState;
  /** Model call used for TLDRs. */
  readonly generateTldr: TldrModelCall;
  /** Monotonic clock used by TLDR scheduling. */
  readonly now: TldrClock;
  /** Delay used to coalesce rapid tool activity. */
  readonly toolActivityCoalesceMs: number;
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
  toolActivityCoalesceMs: number,
  scheduler: TimerScheduler,
): TldrState {
  return {
    sessionActive: false,
    facts: new TldrFactCollector(),
    tldr: {
      runId: 0,
      requestId: 0,
      lastSubmittedFacts: "",
      lastRenderedTldr: "",
      lastTldrStartedAt: Number.NEGATIVE_INFINITY,
    },
    generateTldr,
    now,
    toolActivityCoalesceMs,
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
    state.facts.reset();
    startFreshTldrRun(state);
    clearWidget(ctx);
  });

  // Ends the current session and prevents pending TLDR work from rendering.
  pi.on("session_shutdown", (_event, ctx) => {
    state.sessionActive = false;
    state.facts.reset();
    startFreshTldrRun(state);
    clearWidget(ctx);
  });

  // Starts a new user-prompt run with the prompt as initial TLDR context.
  pi.on("before_agent_start", (event, ctx) => {
    if (!state.sessionActive) return;

    state.facts.reset(event.prompt);
    startFreshTldrRun(state);
    clearWidget(ctx);
    requestTldr(ctx, state, "now");
  });

  // Records streaming assistant progress and rate-limits TLDR updates.
  pi.on("message_update", (event, ctx) => {
    if (!state.sessionActive) return;
    if (!state.facts.recordAssistantUpdate(event.message)) return;

    requestTldr(ctx, state, "throttled");
  });

  // Records the beginning of tool activity and coalesces nearby events.
  pi.on("tool_call", (event, ctx) => {
    if (!state.sessionActive) return;

    state.facts.recordToolCall(event);
    requestTldr(ctx, state, "coalesced");
  });

  // Records the result of tool activity and coalesces nearby events.
  pi.on("tool_result", (event, ctx) => {
    if (!state.sessionActive) return;

    state.facts.recordToolResult(event);
    requestTldr(ctx, state, "coalesced");
  });

  // Records final assistant output or clears stale TLDR state for empty output.
  pi.on("message_end", (event, ctx) => {
    if (!state.sessionActive) return;

    const result = state.facts.recordMessageEnd(event.message);
    if (result === "ignored") return;

    if (result === "emptyFinalStop") {
      discardCurrentTldr(state);
      clearWidget(ctx);
      return;
    }

    requestTldr(ctx, state, "now");
  });
}

/** Starts a new TLDR run and invalidates earlier queued/model work. */
function startFreshTldrRun(state: TldrState): void {
  state.tldr.runId++;
  discardCurrentTldr(state);
}

/** Clears all TLDR state for a run that should no longer show a TLDR. */
function discardCurrentTldr(state: TldrState): void {
  cancelTldrWork(state);
  state.tldr.lastSubmittedFacts = "";
  state.tldr.lastRenderedTldr = "";
}

/** Cancels queued and in-flight model work without clearing rendered/dedupe state. */
function cancelTldrWork(state: TldrState): void {
  state.tldr.requestId++;
  clearUpdateTimer(state);
  state.tldr.queuedTldr = undefined;
  state.tldr.abortController?.abort();
  state.tldr.abortController = undefined;
}

/** Cancels the pending TLDR timer, if one exists. */
function clearUpdateTimer(state: TldrState): void {
  if (state.tldr.updateTimer === undefined) return;

  state.scheduler.clearTimeout(state.tldr.updateTimer);
  state.tldr.updateTimer = undefined;
}

/** Queues a TLDR model request for the latest fact snapshot. */
function requestTldr(
  ctx: ExtensionContext,
  state: TldrState,
  urgency: TldrUrgency,
): void {
  if (!ctx.hasUI || !state.sessionActive) return;

  const snapshot = state.facts.snapshot();
  if (!snapshot || snapshot === state.tldr.lastSubmittedFacts) return;

  state.tldr.lastSubmittedFacts = snapshot;
  state.tldr.requestId++;
  state.tldr.queuedTldr = {
    snapshot,
    configuredModel: state.configuredModel,
    runId: state.tldr.runId,
    requestId: state.tldr.requestId,
  };

  state.tldr.abortController?.abort();
  state.tldr.abortController = undefined;
  clearUpdateTimer(state);

  /** Starts the queued TLDR after its debounce/coalescing delay. */
  function flushQueuedTldr(): void {
    state.tldr.updateTimer = undefined;
    const job = state.tldr.queuedTldr;
    state.tldr.queuedTldr = undefined;
    if (job) void runTldrRequest(ctx, state, job);
  }

  state.tldr.updateTimer = state.scheduler.setTimeout(
    flushQueuedTldr,
    tldrDelay(state, urgency),
  );
}

/** Computes when the next TLDR request should run. */
function tldrDelay(state: TldrState, urgency: TldrUrgency): number {
  switch (urgency) {
    case "now":
      return 0;
    case "coalesced":
      return state.toolActivityCoalesceMs;
    case "throttled":
      return Math.max(
        0,
        MODEL_UPDATE_INTERVAL_MS - (state.now() - state.tldr.lastTldrStartedAt),
      );
  }
}

/** Returns whether queued or in-flight TLDR work still belongs to this run. */
function isCurrentTldrJob(state: TldrState, job: QueuedTldr): boolean {
  return (
    state.sessionActive &&
    job.runId === state.tldr.runId &&
    job.requestId === state.tldr.requestId
  );
}

/** Calls the TLDR model and renders its raw response if still current. */
async function runTldrRequest(
  ctx: ExtensionContext,
  state: TldrState,
  job: QueuedTldr,
): Promise<void> {
  if (!isCurrentTldrJob(state, job)) return;

  let auth;
  try {
    auth = await getFastModelAuth(ctx, job.configuredModel);
  } catch {
    return;
  }

  if (!isCurrentTldrJob(state, job) || !auth) return;

  const abortController = new AbortController();
  state.tldr.abortController = abortController;
  state.tldr.lastTldrStartedAt = state.now();

  try {
    const response = await state.generateTldr(
      auth.model,
      {
        systemPrompt: TLDR_SYSTEM_PROMPT,
        messages: [tldrPrompt(job.snapshot)],
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

    if (!isCurrentTldrJob(state, job)) return;
    if (response.stopReason !== "stop") return;

    const tldr = extractTextContent(response.content) ?? "";
    if (tldr !== state.tldr.lastRenderedTldr) {
      state.tldr.lastRenderedTldr = tldr;
      showWidget(ctx, tldr);
    }
  } catch {
    // TLDRs are best-effort; the next fact snapshot can try again.
  } finally {
    if (state.tldr.abortController === abortController) {
      state.tldr.abortController = undefined;
    }
  }
}

/** Builds the single user message sent to the TLDR model. */
function tldrPrompt(snapshot: string): UserMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `Current event facts:\n${snapshot}`,
      },
    ],
    timestamp: Date.now(),
  };
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
