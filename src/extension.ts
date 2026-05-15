/**
 * @fileoverview pi extension integration, command handling, and TLDR flow.
 *
 * This module is intentionally the thin pi adapter for pi-tldr. It registers
 * commands, maps pi lifecycle/activity events into fact records, and delegates
 * generated-checkpoint orchestration to `TldrCheckpointEngine`.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  TldrCheckpointEngine,
  type TimerScheduler,
  type TldrClock,
  type TldrModelCall,
} from "./checkpoints.js";
import { TldrFactCollector } from "./facts.js";
import {
  formatAuthModelKey,
  formatModelPreference,
  getFastModelAuth,
  resolveInitialModelPreference,
} from "./models.js";
import { clearWidget, notifyUser } from "./tui.js";

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

/** Mutable state for one loaded pi-tldr extension instance. */
export interface TldrState {
  /** Whether the current pi session should accept activity events. */
  sessionActive: boolean;
  /** Activity collector for the current conversation. */
  readonly facts: TldrFactCollector;
  /** Generated TLDR checkpoint engine for the current conversation. */
  readonly checkpoints: TldrCheckpointEngine;
}

/** Creates the mutable state object for a loaded pi-tldr extension. */
export function createTldrState(
  generateTldr: TldrModelCall,
  now: TldrClock,
  displayUpdateIntervalMs: number,
  scheduler: TimerScheduler,
): TldrState {
  const facts = new TldrFactCollector();

  return {
    sessionActive: false,
    facts,
    checkpoints: new TldrCheckpointEngine({
      facts,
      generateTldr,
      now,
      displayUpdateIntervalMs,
      scheduler,
    }),
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
  const configuredModel = state.checkpoints.selectedModel();
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
    state.checkpoints.selectModel(resolveInitialModelPreference(ctx.cwd));
    state.facts.resetConversation();
    state.checkpoints.startFreshRun();
    clearWidget(ctx);
  });

  // Ends the current session and prevents pending TLDR work from rendering.
  pi.on("session_shutdown", (_event, ctx) => {
    state.sessionActive = false;
    state.facts.resetConversation();
    state.checkpoints.startFreshRun();
    clearWidget(ctx);
  });

  // Records a user prompt as a new conversation activity boundary.
  pi.on("before_agent_start", (event, ctx) => {
    if (!state.sessionActive) return;

    const activity = state.facts.recordUserMessage(event.prompt);
    clearWidget(ctx);
    state.checkpoints.enqueue(ctx, activity);
  });

  // Records streaming assistant progress as normal TLDR activity.
  pi.on("message_update", (event, ctx) => {
    if (!state.sessionActive) return;

    const activity = state.facts.recordAssistantUpdate(
      event.message,
      event.assistantMessageEvent,
    );
    if (activity) state.checkpoints.enqueue(ctx, activity);
  });

  // Records the beginning of tool activity.
  pi.on("tool_call", (event, ctx) => {
    if (!state.sessionActive) return;

    state.checkpoints.enqueue(ctx, state.facts.recordToolCall(event));
  });

  // Records the beginning of actual tool execution.
  pi.on("tool_execution_start", (event, ctx) => {
    if (!state.sessionActive) return;

    state.checkpoints.enqueue(ctx, state.facts.recordToolExecutionStart(event));
  });

  // Records streaming progress from a running tool.
  pi.on("tool_execution_update", (event, ctx) => {
    if (!state.sessionActive) return;

    state.checkpoints.enqueue(
      ctx,
      state.facts.recordToolExecutionUpdate(event),
    );
  });

  // Records completed tool execution.
  pi.on("tool_execution_end", (event, ctx) => {
    if (!state.sessionActive) return;

    state.checkpoints.enqueue(ctx, state.facts.recordToolExecutionEnd(event));
  });

  // Records the result of tool activity.
  pi.on("tool_result", (event, ctx) => {
    if (!state.sessionActive) return;

    state.checkpoints.enqueue(ctx, state.facts.recordToolResult(event));
  });

  // Records final assistant output or clears stale TLDR state for empty output.
  pi.on("message_end", (event, ctx) => {
    if (!state.sessionActive) return;

    const result = state.facts.recordMessageEnd(event.message);
    if (result === "ignored") return;

    if (result === "emptyFinalStop") {
      state.facts.resetConversation();
      state.checkpoints.startFreshRun();
      clearWidget(ctx);
      return;
    }

    state.checkpoints.enqueue(ctx, result);
  });
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
