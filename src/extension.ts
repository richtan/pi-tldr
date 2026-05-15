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
import {
  clearNoModelWarning,
  clearWidget,
  notifyUser,
  showNoModelWarning,
} from "./tui.js";

export interface PiTldrDependencies {
  readonly generateTldr?: TldrModelCall;
  readonly now?: TldrClock;
  readonly displayUpdateIntervalMs?: number;
  // Kept so older tests/embedders that used the former option name continue to
  // tune the same UI cadence after the generation/display split.
  readonly toolActivityCoalesceMs?: number;
  readonly scheduler?: TimerScheduler;
}

export interface TldrState {
  sessionActive: boolean;
  readonly facts: TldrFactCollector;
  readonly checkpoints: TldrCheckpointEngine;
}

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

function registerTldrCommand(pi: ExtensionAPI, state: TldrState): void {
  pi.registerCommand("tldr", {
    description: "pi-tldr status",
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
    if (auth) {
      clearNoModelWarning(ctx);
      activeModelLine = `active model: ${formatAuthModelKey(auth)}`;
    } else {
      showNoModelWarning(ctx);
      activeModelLine = "active model: none";
    }
  } catch {
    activeModelLine = "active model: unknown (auth check failed)";
  }

  notifyUser(
    ctx,
    ["pi-tldr status", selectedModelLine, activeModelLine].join("\n"),
    "info",
  );
}

function registerTldrLifecycleHandlers(
  pi: ExtensionAPI,
  state: TldrState,
): void {
  pi.on("session_start", (_event, ctx) => {
    state.sessionActive = true;
    state.checkpoints.selectModel(resolveInitialModelPreference(ctx.cwd));
    state.facts.resetConversation();
    state.checkpoints.startFreshRun();
    clearWidget(ctx);
    clearNoModelWarning(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    state.sessionActive = false;
    state.facts.resetConversation();
    state.checkpoints.startFreshRun();
    clearWidget(ctx);
    clearNoModelWarning(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!state.sessionActive) return;

    const activity = state.facts.recordUserMessage(event.prompt);
    clearWidget(ctx);
    state.checkpoints.enqueue(ctx, activity);
  });

  pi.on("message_update", (event, ctx) => {
    if (!state.sessionActive) return;

    const activity = state.facts.recordAssistantUpdate(
      event.message,
      event.assistantMessageEvent,
    );
    if (activity) state.checkpoints.enqueue(ctx, activity);
  });

  pi.on("tool_call", (event, ctx) => {
    if (!state.sessionActive) return;

    state.checkpoints.enqueue(ctx, state.facts.recordToolCall(event));
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!state.sessionActive) return;

    state.checkpoints.enqueue(ctx, state.facts.recordToolExecutionStart(event));
  });

  pi.on("tool_execution_update", (event, ctx) => {
    if (!state.sessionActive) return;

    state.checkpoints.enqueue(
      ctx,
      state.facts.recordToolExecutionUpdate(event),
    );
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!state.sessionActive) return;

    state.checkpoints.enqueue(ctx, state.facts.recordToolExecutionEnd(event));
  });

  pi.on("tool_result", (event, ctx) => {
    if (!state.sessionActive) return;

    state.checkpoints.enqueue(ctx, state.facts.recordToolResult(event));
  });

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

export function registerTldrExtension(
  pi: ExtensionAPI,
  state: TldrState,
): void {
  registerTldrCommand(pi, state);
  registerTldrLifecycleHandlers(pi, state);
}
