/**
 * pi-tldr extension.
 *
 * Shows a compact live summary box above the input editor. It renders fast-LLM
 * TLDR output from typed agent lifecycle facts.
 */

import {
  complete,
  type ProviderStreamOptions,
  type UserMessage,
} from "@mariozechner/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import {
  type Component,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { extractTextContent, TldrFactSession } from "./tldr-facts.js";
import {
  applyModelPreferenceChoice,
  type FastModelAuth,
  getFastModelAuth,
  resolveInitialModelPreference,
  selectTldrModel,
  TLDR_MODEL_FLAG,
  type TldrModelPreference,
} from "./tldr-models.js";
import { extractSummary } from "./tldr-core.js";

const WIDGET_KEY = "pi-tldr";
const TITLE = " tldr ";
const MIN_BOX_WIDTH = 12;
const MAX_SUMMARY_CHARS = 180;
const LLM_UPDATE_INTERVAL_MS = 1_200;
const TLDR_MAX_TOKENS = 80;
const TLDR_REQUEST_TIMEOUT_MS = 8_000;

interface RuntimeState {
  active: boolean;
  preferredModel?: TldrModelPreference;
  generation: number;
  refinementGeneration: number;
  currentSummary: string;
  lastFacts: string;
  lastLlmStart: number;
  pendingRequest?: RefinementRequest;
  updateTimer?: ReturnType<typeof setTimeout>;
  activeRequest?: AbortController;
  readonly facts: TldrFactSession;
}

interface RefinementRequest {
  readonly facts: string;
  readonly generation: number;
  readonly refinementGeneration: number;
}

const TLDR_SYSTEM_PROMPT = `You write live status TLDRs for a terminal coding agent.
Return one short, complete, plain-English sentence.
The sentence must be complete and must not trail off.
Describe the current workflow step for the user's task.
For in-progress work, start with a present-tense action verb form ending in -ing.
For final results or completed work, start with a past-tense action verb.
Do not use first person.
Do not address the user directly.
Do not speak as the assistant.
Do not output JSON, markdown, code, logs, diffs, XML, bullet points, or quoted strings.
Do not mention tool names, command names, raw arguments, or individual file names.
Output only the TLDR sentence.`;

class PiTldrBox implements Component {
  public constructor(
    private readonly theme: Theme,
    private readonly summary: string,
  ) {}

  public invalidate(): void {
    // Stateless: render uses constructor data.
  }

  public render(width: number): string[] {
    if (width < MIN_BOX_WIDTH) return [`${TITLE.trim()}: ${this.summary}`];

    const contentWidth = width - 4;
    const lines = wrapTextWithAnsi(this.summary, contentWidth);
    return [
      this.topBorder(width),
      ...(lines.length === 0 ? [""] : lines).map((line) =>
        this.contentLine(line, contentWidth),
      ),
      this.bottomBorder(width),
    ];
  }

  private topBorder(width: number): string {
    const rightWidth = Math.max(1, width - visibleWidth(TITLE) - 2);
    return this.theme.fg("borderMuted", `╭${TITLE}${"─".repeat(rightWidth)}╮`);
  }

  private bottomBorder(width: number): string {
    return this.theme.fg("borderMuted", `╰${"─".repeat(width - 2)}╯`);
  }

  private contentLine(line: string, contentWidth: number): string {
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
    return [
      this.theme.fg("borderMuted", "│ "),
      this.theme.fg("text", line),
      padding,
      this.theme.fg("borderMuted", " │"),
    ].join("");
  }
}

function createInitialState(): RuntimeState {
  return {
    active: false,
    generation: 0,
    refinementGeneration: 0,
    currentSummary: "",
    lastFacts: "",
    lastLlmStart: 0,
    facts: new TldrFactSession(),
  };
}

function clearWidget(ctx: ExtensionContext): void {
  if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function showWidget(ctx: ExtensionContext, summary: string): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
    void tui;
    return new PiTldrBox(theme, summary);
  });
}

function notifyUser(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "error",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function resetRunState(state: RuntimeState, prompt?: string): void {
  clearPendingWork(state);
  state.facts.reset(prompt);
  state.currentSummary = "";
  state.lastFacts = "";
}

function createCompletionOptions(
  auth: FastModelAuth,
  signal: AbortSignal,
): ProviderStreamOptions {
  const options: ProviderStreamOptions = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    maxTokens: TLDR_MAX_TOKENS,
    maxRetries: 0,
    cacheRetention: "none",
    timeoutMs: TLDR_REQUEST_TIMEOUT_MS,
    signal,
  };

  return options;
}

function clearPendingWork(state: RuntimeState): void {
  state.refinementGeneration++;
  if (state.updateTimer) clearTimeout(state.updateTimer);
  state.updateTimer = undefined;
  state.pendingRequest = undefined;
  state.activeRequest?.abort();
  state.activeRequest = undefined;
}

function isCurrent(state: RuntimeState, request: RefinementRequest): boolean {
  return (
    state.active &&
    request.generation === state.generation &&
    request.refinementGeneration === state.refinementGeneration
  );
}

function renderSummary(
  ctx: ExtensionContext,
  state: RuntimeState,
  summary: string,
): void {
  if (summary === state.currentSummary) return;

  state.currentSummary = summary;
  showWidget(ctx, summary);
}

function requestRefinement(
  ctx: ExtensionContext,
  state: RuntimeState,
  urgency: "debounced" | "now",
): void {
  if (!ctx.hasUI) return;

  const facts = state.facts.snapshot();
  if (!facts || facts === state.lastFacts) return;

  state.lastFacts = facts;
  state.refinementGeneration++;
  state.pendingRequest = {
    facts,
    generation: state.generation,
    refinementGeneration: state.refinementGeneration,
  };
  state.activeRequest?.abort();
  state.activeRequest = undefined;

  if (state.updateTimer) clearTimeout(state.updateTimer);
  const elapsedSinceLastLlm = Date.now() - state.lastLlmStart;
  const delay =
    urgency === "now"
      ? 0
      : Math.max(0, LLM_UPDATE_INTERVAL_MS - elapsedSinceLastLlm);
  state.updateTimer = setTimeout(() => flushRefinement(ctx, state), delay);
}

function flushRefinement(ctx: ExtensionContext, state: RuntimeState): void {
  state.updateTimer = undefined;
  const request = state.pendingRequest;
  state.pendingRequest = undefined;
  if (!request) return;

  void generateSummary(ctx, state, request);
}

async function generateSummary(
  ctx: ExtensionContext,
  state: RuntimeState,
  request: RefinementRequest,
): Promise<void> {
  if (!isCurrent(state, request)) return;

  let auth: FastModelAuth | undefined;
  try {
    auth = await getFastModelAuth(ctx, state.preferredModel);
  } catch {
    return;
  }
  if (!auth || !isCurrent(state, request)) return;

  const abortController = new AbortController();
  state.activeRequest = abortController;
  state.lastLlmStart = Date.now();

  try {
    const message: UserMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: `Current event facts:\n${request.facts}`,
        },
      ],
      timestamp: Date.now(),
    };
    const response = await complete(
      auth.model,
      { systemPrompt: TLDR_SYSTEM_PROMPT, messages: [message] },
      createCompletionOptions(auth, abortController.signal),
    );
    if (!isCurrent(state, request) || response.stopReason !== "stop") return;

    const responseText = extractTextContent(response.content) ?? "";
    const summary = extractSummary(responseText, MAX_SUMMARY_CHARS);
    if (summary) renderSummary(ctx, state, summary);
  } catch {
    // TLDR refinement is optional; keep the previous accepted TLDR on failure.
  } finally {
    if (state.activeRequest === abortController)
      state.activeRequest = undefined;
  }
}

export function piTldr(pi: ExtensionAPI): void {
  pi.registerFlag(TLDR_MODEL_FLAG, {
    description:
      "Preferred model for pi-tldr summaries, in provider/model-id format",
    type: "string",
  });

  const state = createInitialState();

  pi.registerCommand("tldr-model", {
    description: "Choose the model used for pi-tldr summaries",
    handler: async (args, ctx) => {
      let value = args.trim();
      if (!value) {
        if (!ctx.hasUI) return;

        const choice = await selectTldrModel(ctx, state.preferredModel);
        if (!choice) return;
        value = choice;
      }

      const update = applyModelPreferenceChoice(value);
      if (!update.ok) {
        notifyUser(ctx, update.message, "error");
        return;
      }

      state.preferredModel = update.preferredModel;
      state.lastFacts = "";
      requestRefinement(ctx, state, "now");
      notifyUser(ctx, update.notice, "info");
    },
  });

  pi.on("session_start", (event, ctx) => {
    void event;
    state.generation++;
    state.active = true;
    resetRunState(state);
    state.preferredModel = resolveInitialModelPreference(
      pi.getFlag(TLDR_MODEL_FLAG),
    );
    clearWidget(ctx);
  });

  pi.on("session_shutdown", () => {
    state.active = false;
    state.generation++;
    resetRunState(state);
  });

  pi.on("before_agent_start", (event, ctx) => {
    state.generation++;
    resetRunState(state, event.prompt);
    clearWidget(ctx);
    requestRefinement(ctx, state, "now");
  });

  pi.on("message_update", (event, ctx) => {
    if (!state.facts.recordAssistantUpdate(event.message)) return;
    requestRefinement(ctx, state, "debounced");
  });

  pi.on("tool_call", (event, ctx) => {
    state.facts.recordToolCall(event);
    requestRefinement(ctx, state, "now");
  });

  pi.on("tool_result", (event, ctx) => {
    state.facts.recordToolResult(event);
    requestRefinement(ctx, state, "now");
  });

  pi.on("message_end", (event, ctx) => {
    const result = state.facts.recordMessageEnd(event.message);
    if (result === "ignored") return;

    if (result === "emptyFinalStop") {
      clearPendingWork(state);
      state.currentSummary = "";
      state.lastFacts = "";
      clearWidget(ctx);
      return;
    }

    requestRefinement(ctx, state, "now");
  });
}

export default piTldr;
