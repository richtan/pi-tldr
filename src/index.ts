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
  type PreferredModelStore,
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
const TOOL_ACTIVITY_COALESCE_MS = 300;
const TLDR_MAX_TOKENS = 80;
const TLDR_REQUEST_TIMEOUT_MS = 8_000;

type CompleteFunction = typeof complete;
type Clock = () => number;
type TimerHandle = unknown;

export interface TldrScheduler {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface PiTldrDependencies {
  readonly complete?: CompleteFunction;
  readonly preferredModelStore?: PreferredModelStore;
  readonly latencyNow?: Clock;
  readonly wallClockNow?: Clock;
  readonly toolActivityCoalesceMs?: number;
  readonly scheduler?: TldrScheduler;
}

type RefinementUrgency = "now" | "debounced" | "coalesced";

interface RuntimeState {
  active: boolean;
  enabled: boolean;
  preferredModel?: TldrModelPreference;
  generation: number;
  refinementGeneration: number;
  currentSummary: string;
  lastFacts: string;
  lastLlmStart: number;
  latencySamples: number;
  totalLatencyMs: number;
  pendingRequest?: RefinementRequest;
  updateTimer?: TimerHandle;
  activeRequest?: AbortController;
  cachedAuth?: CachedAuth;
  authCacheVersion: number;
  readonly facts: TldrFactSession;
  readonly complete: CompleteFunction;
  readonly latencyNow: Clock;
  readonly wallClockNow: Clock;
  readonly toolActivityCoalesceMs: number;
  readonly scheduler: TldrScheduler;
}

interface CachedAuth {
  readonly modelKey: string;
  readonly auth: FastModelAuth;
}

interface RefinementRequest {
  readonly facts: string;
  readonly generation: number;
  readonly refinementGeneration: number;
  readonly triggeredAtMs: number;
}

interface StatusSnapshot {
  readonly enabled: boolean;
  readonly preferredModel?: TldrModelPreference;
  readonly modelPreference: string;
  readonly generation: number;
}

const TLDR_SYSTEM_PROMPT = `You write live status TLDRs for a terminal coding agent.
Return one short, complete, plain-English sentence.
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

function createDefaultScheduler(): TldrScheduler {
  return {
    setTimeout(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    clearTimeout(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

function createInitialState(
  completeTldr: CompleteFunction,
  latencyNow: Clock,
  wallClockNow: Clock,
  toolActivityCoalesceMs: number,
  scheduler: TldrScheduler,
): RuntimeState {
  return {
    active: false,
    enabled: true,
    generation: 0,
    refinementGeneration: 0,
    currentSummary: "",
    lastFacts: "",
    lastLlmStart: Number.NEGATIVE_INFINITY,
    latencySamples: 0,
    totalLatencyMs: 0,
    authCacheVersion: 0,
    facts: new TldrFactSession(),
    complete: completeTldr,
    latencyNow,
    wallClockNow,
    toolActivityCoalesceMs,
    scheduler,
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

function formatModelPreference(preferredModel?: TldrModelPreference): string {
  return preferredModel ? formatTldrModelKey(preferredModel) : "auto";
}

function formatTldrModelKey({ provider, id }: TldrModelPreference): string {
  return `${provider}/${id}`;
}

function formatAuthModelKey(auth: FastModelAuth): string {
  return `${auth.model.provider}/${auth.model.id}`;
}

function createStatusSnapshot(state: RuntimeState): StatusSnapshot {
  return {
    enabled: state.enabled,
    preferredModel: state.preferredModel,
    modelPreference: formatModelPreference(state.preferredModel),
    generation: state.generation,
  };
}

function statusSnapshotMatches(
  state: RuntimeState,
  snapshot: StatusSnapshot,
): boolean {
  const current = createStatusSnapshot(state);
  return (
    current.enabled === snapshot.enabled &&
    current.modelPreference === snapshot.modelPreference &&
    current.generation === snapshot.generation
  );
}

async function activeModelStatusLine(
  ctx: ExtensionContext,
  snapshot: StatusSnapshot,
): Promise<string> {
  if (!snapshot.enabled) return "active model: none";

  try {
    const auth = await getFastModelAuth(ctx, snapshot.preferredModel);
    return auth
      ? `active model: ${auth.model.provider}/${auth.model.id}`
      : "active model: none";
  } catch {
    return "active model: unknown (auth check failed)";
  }
}

function formatStatusReport(
  snapshot: StatusSnapshot,
  activeModelLine: string,
): string {
  return [
    "pi-tldr status",
    `enabled: ${snapshot.enabled ? "yes" : "no"}`,
    `selected model: ${snapshot.modelPreference}`,
    activeModelLine,
  ].join("\n");
}

async function createStatusReport(
  ctx: ExtensionContext,
  state: RuntimeState,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = createStatusSnapshot(state);
    const activeModelLine = await activeModelStatusLine(ctx, snapshot);
    if (statusSnapshotMatches(state, snapshot)) {
      return formatStatusReport(snapshot, activeModelLine);
    }
  }

  return [
    "pi-tldr status",
    "status changed while checking; run /tldr again",
  ].join("\n");
}

async function notifyTldrStatus(
  ctx: ExtensionContext,
  state: RuntimeState,
): Promise<void> {
  notifyUser(ctx, await createStatusReport(ctx, state), "info");
}

function notifyTldrHelp(ctx: ExtensionContext): void {
  notifyUser(
    ctx,
    [
      "pi-tldr commands",
      "/tldr help - show this help",
      "/tldr status - show enabled and model status",
      "/tldr stats - show session latency stats",
      "/tldr on - enable TLDRs for this session",
      "/tldr off - disable TLDRs for this session",
      "/tldr toggle - toggle TLDRs for this session",
      "/tldr model - choose the TLDR model",
      "/tldr model <model|auto|reset> - set the TLDR model",
    ].join("\n"),
    "info",
  );
}

function formatLatencyStats(state: RuntimeState): string {
  const averageLatency = state.latencySamples
    ? `${Math.round(state.totalLatencyMs / state.latencySamples)}ms`
    : "n/a";

  return [
    "pi-tldr stats",
    `avg latency: ${averageLatency}`,
    `samples: ${state.latencySamples}`,
  ].join("\n");
}

function notifyTldrStats(ctx: ExtensionContext, state: RuntimeState): void {
  notifyUser(ctx, formatLatencyStats(state), "info");
}

function setTldrEnabled(
  ctx: ExtensionContext,
  state: RuntimeState,
  enabled: boolean,
): void {
  if (!enabled) clearCachedAuth(state);

  if (state.enabled === enabled) {
    notifyUser(
      ctx,
      `pi-tldr is already ${enabled ? "enabled" : "disabled"}`,
      "info",
    );
    return;
  }

  state.enabled = enabled;
  if (!enabled) {
    clearPendingWork(state);
    state.facts.reset();
    state.currentSummary = "";
    state.lastFacts = "";
    clearWidget(ctx);
    notifyUser(ctx, "pi-tldr disabled for this session", "info");
    return;
  }

  state.lastFacts = "";
  requestRefinement(ctx, state, "now");
  notifyUser(ctx, "pi-tldr enabled for this session", "info");
}

function resetRunState(state: RuntimeState, prompt?: string): void {
  clearPendingWork(state);
  state.facts.reset(prompt);
  state.currentSummary = "";
  state.lastFacts = "";
}

function resetLatencyStats(state: RuntimeState): void {
  state.latencySamples = 0;
  state.totalLatencyMs = 0;
}

function clearCachedAuth(state: RuntimeState): void {
  state.authCacheVersion++;
  state.cachedAuth = undefined;
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
  if (state.updateTimer !== undefined) {
    state.scheduler.clearTimeout(state.updateTimer);
  }
  state.updateTimer = undefined;
  state.pendingRequest = undefined;
  state.activeRequest?.abort();
  state.activeRequest = undefined;
}

function isCurrent(state: RuntimeState, request: RefinementRequest): boolean {
  return (
    state.active &&
    state.enabled &&
    request.generation === state.generation &&
    request.refinementGeneration === state.refinementGeneration
  );
}

function renderSummary(
  ctx: ExtensionContext,
  state: RuntimeState,
  summary: string,
): boolean {
  if (summary === state.currentSummary) return false;

  state.currentSummary = summary;
  showWidget(ctx, summary);
  return true;
}

function recordLatency(state: RuntimeState, request: RefinementRequest): void {
  state.latencySamples++;
  state.totalLatencyMs += Math.max(
    0,
    state.latencyNow() - request.triggeredAtMs,
  );
}

function requestRefinement(
  ctx: ExtensionContext,
  state: RuntimeState,
  urgency: RefinementUrgency,
): void {
  if (!ctx.hasUI || !state.enabled) return;

  const facts = state.facts.snapshot();
  if (!facts || facts === state.lastFacts) return;

  state.lastFacts = facts;
  state.refinementGeneration++;
  state.pendingRequest = {
    facts,
    generation: state.generation,
    refinementGeneration: state.refinementGeneration,
    triggeredAtMs: state.latencyNow(),
  };
  state.activeRequest?.abort();
  state.activeRequest = undefined;

  if (state.updateTimer !== undefined) {
    state.scheduler.clearTimeout(state.updateTimer);
  }
  const elapsedSinceLastLlm = state.latencyNow() - state.lastLlmStart;
  const delay = refinementDelay(state, urgency, elapsedSinceLastLlm);
  state.updateTimer = state.scheduler.setTimeout(
    () => flushRefinement(ctx, state),
    delay,
  );
}

function refinementDelay(
  state: RuntimeState,
  urgency: RefinementUrgency,
  elapsedSinceLastLlm: number,
): number {
  switch (urgency) {
    case "now":
      return 0;
    case "coalesced":
      return state.toolActivityCoalesceMs;
    case "debounced":
      return Math.max(0, LLM_UPDATE_INTERVAL_MS - elapsedSinceLastLlm);
  }
}

async function resolveTldrAuth(
  ctx: ExtensionContext,
  state: RuntimeState,
  request: RefinementRequest,
): Promise<FastModelAuth | undefined> {
  const requestedModelKey = state.preferredModel
    ? formatTldrModelKey(state.preferredModel)
    : undefined;
  if (requestedModelKey && state.cachedAuth?.modelKey === requestedModelKey) {
    return state.cachedAuth.auth;
  }

  const cacheVersion = state.authCacheVersion;
  const auth = await getFastModelAuth(ctx, state.preferredModel);
  if (
    auth &&
    requestedModelKey &&
    cacheVersion === state.authCacheVersion &&
    isCurrent(state, request) &&
    requestedModelKey ===
      (state.preferredModel
        ? formatTldrModelKey(state.preferredModel)
        : undefined) &&
    requestedModelKey === formatAuthModelKey(auth)
  ) {
    state.cachedAuth = { modelKey: requestedModelKey, auth };
  }
  return auth;
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
    auth = await resolveTldrAuth(ctx, state, request);
  } catch {
    clearCachedAuth(state);
    return;
  }
  if (!auth || !isCurrent(state, request)) return;

  const abortController = new AbortController();
  state.activeRequest = abortController;
  state.lastLlmStart = state.latencyNow();

  try {
    const message: UserMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: `Current event facts:\n${request.facts}`,
        },
      ],
      timestamp: state.wallClockNow(),
    };
    const response = await state.complete(
      auth.model,
      { systemPrompt: TLDR_SYSTEM_PROMPT, messages: [message] },
      createCompletionOptions(auth, abortController.signal),
    );
    if (!isCurrent(state, request)) return;
    if (response.stopReason !== "stop") {
      if (response.stopReason === "error") clearCachedAuth(state);
      return;
    }

    const responseText = extractTextContent(response.content) ?? "";
    const summary = extractSummary(responseText, MAX_SUMMARY_CHARS);
    if (summary && renderSummary(ctx, state, summary)) {
      recordLatency(state, request);
    }
  } catch {
    if (!abortController.signal.aborted) clearCachedAuth(state);
    // TLDR refinement is optional; keep the previous accepted TLDR on failure.
  } finally {
    if (state.activeRequest === abortController)
      state.activeRequest = undefined;
  }
}

export function createPiTldr(
  dependencies: PiTldrDependencies = {},
): (pi: ExtensionAPI) => void {
  const completeTldr = dependencies.complete ?? complete;
  const preferredModelStore = dependencies.preferredModelStore;
  const latencyNow = dependencies.latencyNow ?? (() => performance.now());
  const wallClockNow = dependencies.wallClockNow ?? Date.now;
  const toolActivityCoalesceMs = Math.max(
    0,
    dependencies.toolActivityCoalesceMs ?? TOOL_ACTIVITY_COALESCE_MS,
  );
  const scheduler = dependencies.scheduler ?? createDefaultScheduler();

  return (pi: ExtensionAPI): void => {
    pi.registerFlag(TLDR_MODEL_FLAG, {
      description:
        "Preferred model for pi-tldr summaries, in provider/model-id format",
      type: "string",
    });

    const state = createInitialState(
      completeTldr,
      latencyNow,
      wallClockNow,
      toolActivityCoalesceMs,
      scheduler,
    );

    pi.registerCommand("tldr", {
      description: "Control pi-tldr status, enablement, and model selection",
      handler: async (args, ctx) => {
        const trimmedArgs = args.trim();
        if (!trimmedArgs) {
          notifyTldrHelp(ctx);
          return;
        }

        const [action, ...rest] = trimmedArgs.split(/\s+/);
        const normalizedAction = action.toLowerCase();

        if (normalizedAction === "help") {
          notifyTldrHelp(ctx);
          return;
        }

        if (normalizedAction === "status") {
          await notifyTldrStatus(ctx, state);
          return;
        }

        if (normalizedAction === "stats") {
          notifyTldrStats(ctx, state);
          return;
        }

        if (normalizedAction === "toggle") {
          setTldrEnabled(ctx, state, !state.enabled);
          return;
        }

        if (["on", "enable", "enabled"].includes(normalizedAction)) {
          setTldrEnabled(ctx, state, true);
          return;
        }

        if (["off", "disable", "disabled"].includes(normalizedAction)) {
          setTldrEnabled(ctx, state, false);
          return;
        }

        if (normalizedAction === "model") {
          let value = rest.join(" ").trim();
          if (!value) {
            if (!ctx.hasUI) return;

            const choice = await selectTldrModel(ctx, state.preferredModel);
            if (!choice) return;
            value = choice;
          }

          const update = applyModelPreferenceChoice(value, preferredModelStore);
          if (!update.ok) {
            notifyUser(ctx, update.message, "error");
            return;
          }

          state.preferredModel = update.preferredModel;
          clearCachedAuth(state);
          state.lastFacts = "";
          requestRefinement(ctx, state, "now");
          notifyUser(ctx, update.notice, "info");
          return;
        }

        notifyUser(
          ctx,
          "Use /tldr [help|status|stats|on|off|toggle|model <model>]",
          "error",
        );
      },
    });

    pi.on("session_start", (event, ctx) => {
      void event;
      state.generation++;
      state.active = true;
      state.enabled = true;
      resetRunState(state);
      resetLatencyStats(state);
      clearCachedAuth(state);
      state.preferredModel = resolveInitialModelPreference(
        pi.getFlag(TLDR_MODEL_FLAG),
        preferredModelStore,
      );
      clearWidget(ctx);
    });

    pi.on("session_shutdown", () => {
      state.active = false;
      state.generation++;
      resetRunState(state);
      clearCachedAuth(state);
    });

    pi.on("before_agent_start", (event, ctx) => {
      state.generation++;
      resetRunState(state, state.enabled ? event.prompt : undefined);
      clearWidget(ctx);
      requestRefinement(ctx, state, "now");
    });

    pi.on("message_update", (event, ctx) => {
      if (!state.enabled) return;
      if (!state.facts.recordAssistantUpdate(event.message)) return;
      requestRefinement(ctx, state, "debounced");
    });

    pi.on("tool_call", (event, ctx) => {
      if (!state.enabled) return;
      state.facts.recordToolCall(event);
      requestRefinement(ctx, state, "coalesced");
    });

    pi.on("tool_result", (event, ctx) => {
      if (!state.enabled) return;
      state.facts.recordToolResult(event);
      requestRefinement(ctx, state, "coalesced");
    });

    pi.on("message_end", (event, ctx) => {
      if (!state.enabled) return;
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
  };
}

export const piTldr = createPiTldr();

export default piTldr;
