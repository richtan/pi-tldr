/**
 * pi-tldr extension.
 *
 * Shows a compact live summary box above the input editor. It renders fast-LLM
 * TLDR output from typed agent lifecycle facts.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  complete,
  type ImageContent,
  type Model,
  type ProviderStreamOptions,
  type TextContent,
  type UserMessage,
} from "@mariozechner/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
  ModelSelectorComponent,
  SettingsManager,
  type Theme,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import {
  type Component,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

const WIDGET_KEY = "pi-tldr";
const TLDR_MODEL_FLAG = "tldr-model";
const TLDR_MODEL_CONFIG_FILE = "pi-tldr.json";
const AUTOMATIC_MODEL_CHOICE = "auto";
const AUTOMATIC_MODEL_PROVIDER = "pi-tldr";
const TITLE = " tldr ";
const MIN_BOX_WIDTH = 12;
const MAX_FACT_CHARS = 1_800;
const MAX_PROMPT_CHARS = 220;
const MAX_ACTIVITY_HISTORY = 5;
const MAX_SUMMARY_CHARS = 180;
const LLM_UPDATE_INTERVAL_MS = 1_200;
const TLDR_MAX_TOKENS = 80;
const FINAL_RESULT_CONTEXT_CHARS = 1_200;

const SUMMARY_FORMAT_PATTERN =
  /^['"`]|['"`]$|```|\[[^\]]+]\([^)]*\)|^\s*[-*+]\s+|^\s*#{1,6}\s+|<[^>]+>/;
const STRUCTURED_TOKEN_PATTERN = /[{}[\]":,]/;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

interface ModelCandidate {
  readonly provider: string;
  readonly id: string;
}

interface FastModelAuth {
  readonly model: Model<Api>;
  readonly apiKey: string;
  readonly headers?: Record<string, string>;
}

interface RuntimeState {
  active: boolean;
  preferredModel?: ModelCandidate;
  generation: number;
  refinementGeneration: number;
  prompt: string;
  readonly activity: string[];
  currentSummary: string;
  lastFacts: string;
  lastLlmStart: number;
  pendingRequest?: RefinementRequest;
  updateTimer?: ReturnType<typeof setTimeout>;
  activeRequest?: AbortController;
  readonly toolFactById: Map<string, string>;
}

interface RefinementRequest {
  readonly facts: string;
  readonly generation: number;
  readonly refinementGeneration: number;
}

type PreferenceOperationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

interface PreferredModelConfig {
  readonly model?: string;
}

type AssistantContent = AssistantMessage["content"][number];
type TextSourceContent = AssistantContent | TextContent | ImageContent;

type Urgency = "debounced" | "now";

type ModelSelectorRegistry = ConstructorParameters<
  typeof ModelSelectorComponent
>[3];

const FAST_MODEL_CANDIDATES: readonly ModelCandidate[] = [
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
  { provider: "openai-codex", id: "gpt-5.4-mini" },
  { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
];

const AUTOMATIC_TLDR_MODEL: Model<Api> = {
  id: AUTOMATIC_MODEL_CHOICE,
  name: "Automatic",
  api: "pi-tldr-automatic",
  provider: AUTOMATIC_MODEL_PROVIDER,
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
};

const MODEL_SELECTOR_SETTINGS = SettingsManager.inMemory();

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
    prompt: "",
    activity: [],
    currentSummary: "",
    lastFacts: "",
    lastLlmStart: 0,
    toolFactById: new Map(),
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

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars?: number): string {
  const normalized = normalizeText(text);
  if (maxChars === undefined) return normalized;
  if (maxChars <= 0) return "";
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 1)}…`;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function factField(name: string, value: string, maxChars?: number): string {
  return `${name}=${truncateText(stripAnsi(value), maxChars)}`;
}

function isAssistantMessage(
  message: AgentMessage,
): message is AssistantMessage {
  return "role" in message && message.role === "assistant";
}

function isTextContent(content: TextSourceContent): content is TextContent {
  return content.type === "text";
}

function extractTextContent(
  content: readonly TextSourceContent[],
): string | undefined {
  const text = content
    .filter(isTextContent)
    .map(({ text }) => text)
    .join("\n")
    .trim();
  return text || undefined;
}

function formatModelSpec({ provider, id }: ModelCandidate): string {
  return `${provider}/${id}`;
}

function formatRegistryModel({ provider, id }: Model<Api>): string {
  return `${provider}/${id}`;
}

function parseModelSpec(value: string): ModelCandidate | undefined {
  const trimmed = value.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return undefined;
  return {
    provider: trimmed.slice(0, separator),
    id: trimmed.slice(separator + 1),
  };
}

function parseModelFlag(
  value: string | boolean | undefined,
): ModelCandidate | undefined {
  return typeof value === "string" ? parseSupportedModelSpec(value) : undefined;
}

function isSupportedTldrModel(candidate: ModelCandidate): boolean {
  return FAST_MODEL_CANDIDATES.some(
    (supported) => formatModelSpec(supported) === formatModelSpec(candidate),
  );
}

function parseSupportedModelSpec(value: string): ModelCandidate | undefined {
  const candidate = parseModelSpec(value);
  return candidate && isSupportedTldrModel(candidate) ? candidate : undefined;
}

function supportedModelList(): string {
  return FAST_MODEL_CANDIDATES.map(formatModelSpec).join(", ");
}

function modelCandidates(
  preferredModel?: ModelCandidate,
): readonly ModelCandidate[] {
  if (!preferredModel) return FAST_MODEL_CANDIDATES;
  return [
    preferredModel,
    ...FAST_MODEL_CANDIDATES.filter(
      (candidate) =>
        formatModelSpec(candidate) !== formatModelSpec(preferredModel),
    ),
  ];
}

function tldrConfigPath(): string {
  return join(getAgentDir(), TLDR_MODEL_CONFIG_FILE);
}

function parsePreferredModelConfig(configText: string): string | undefined {
  try {
    const value = JSON.parse(configText) as PreferredModelConfig | null;
    return value && typeof value.model === "string" ? value.model : undefined;
  } catch {
    return undefined;
  }
}

function loadPreferredModel(): ModelCandidate | undefined {
  try {
    const path = tldrConfigPath();
    if (!existsSync(path)) return undefined;

    const modelSpec = parsePreferredModelConfig(readFileSync(path, "utf8"));
    return modelSpec ? parseSupportedModelSpec(modelSpec) : undefined;
  } catch {
    return undefined;
  }
}

function savePreferredModel(
  preferredModel: ModelCandidate,
): PreferenceOperationResult {
  const path = tldrConfigPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ model: formatModelSpec(preferredModel) }, null, 2)}\n`,
    );
    return { ok: true };
  } catch {
    return { ok: false, message: "preference could not be saved" };
  }
}

function clearPreferredModel(): PreferenceOperationResult {
  try {
    rmSync(tldrConfigPath(), { force: true });
    return { ok: true };
  } catch {
    return { ok: false, message: "saved preference could not be removed" };
  }
}

function isAutomaticModel({ provider, id }: Model<Api>): boolean {
  return provider === AUTOMATIC_MODEL_PROVIDER && id === AUTOMATIC_MODEL_CHOICE;
}

function createModelSelectorRegistry(
  ctx: ExtensionContext,
): ModelSelectorRegistry {
  return new Proxy(ctx.modelRegistry, {
    get(target, property, receiver) {
      if (property === "find") {
        return (provider: string, id: string) =>
          provider === AUTOMATIC_MODEL_PROVIDER && id === AUTOMATIC_MODEL_CHOICE
            ? AUTOMATIC_TLDR_MODEL
            : target.find(provider, id);
      }

      if (property === "getAvailable") {
        return () => {
          const availableBySpec = new Map(
            target
              .getAvailable()
              .map((model) => [formatRegistryModel(model), model]),
          );
          return [
            AUTOMATIC_TLDR_MODEL,
            ...FAST_MODEL_CANDIDATES.map(formatModelSpec)
              .map((spec) => availableBySpec.get(spec))
              .filter((model): model is Model<Api> => model !== undefined),
          ];
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ModelSelectorRegistry;
}

async function selectTldrModel(
  ctx: ExtensionContext,
  state: RuntimeState,
): Promise<string | undefined> {
  const selectorRegistry = createModelSelectorRegistry(ctx);
  const currentModel = state.preferredModel
    ? (selectorRegistry.find(
        state.preferredModel.provider,
        state.preferredModel.id,
      ) ?? AUTOMATIC_TLDR_MODEL)
    : AUTOMATIC_TLDR_MODEL;

  const selectedModel = await ctx.ui.custom<Model<Api> | undefined>(
    (tui, theme, keybindings, done) => {
      void theme;
      void keybindings;
      return new ModelSelectorComponent(
        tui,
        currentModel,
        MODEL_SELECTOR_SETTINGS,
        selectorRegistry,
        [],
        (model) => done(model),
        () => done(undefined),
      );
    },
  );

  if (!selectedModel) return undefined;
  return isAutomaticModel(selectedModel)
    ? AUTOMATIC_MODEL_CHOICE
    : formatRegistryModel(selectedModel);
}

function toolCallFact(event: ToolCallEvent): string {
  if (isToolCallEventType("bash", event)) {
    return [
      "event=tool_start",
      "tool=bash",
      factField("command", event.input.command, 240),
    ].join("\n");
  }
  if (isToolCallEventType("read", event)) {
    const { path, offset, limit } = event.input;
    return [
      "event=tool_start",
      "tool=read",
      factField("path", path, 240),
      offset === undefined ? undefined : `offset=${String(offset)}`,
      limit === undefined ? undefined : `limit=${String(limit)}`,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }
  if (isToolCallEventType("grep", event)) {
    const { pattern, path, glob } = event.input;
    return [
      "event=tool_start",
      "tool=grep",
      factField("pattern", pattern, 160),
      path ? factField("path", path, 240) : undefined,
      glob ? factField("glob", glob) : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }
  if (isToolCallEventType("find", event)) {
    const { pattern, path } = event.input;
    return [
      "event=tool_start",
      "tool=find",
      factField("pattern", pattern, 160),
      path ? factField("path", path, 240) : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }
  if (isToolCallEventType("ls", event)) {
    return [
      "event=tool_start",
      "tool=ls",
      event.input.path ? factField("path", event.input.path, 240) : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }
  if (isToolCallEventType("edit", event)) {
    return [
      "event=tool_start",
      "tool=edit",
      factField("path", event.input.path, 240),
      `editCount=${String(event.input.edits.length)}`,
    ].join("\n");
  }
  if (isToolCallEventType("write", event)) {
    return [
      "event=tool_start",
      "tool=write",
      factField("path", event.input.path, 240),
    ].join("\n");
  }
  return [
    "event=tool_start",
    "tool=custom",
    factField("toolName", event.toolName),
  ].join("\n");
}

function toolResultFact(
  event: ToolResultEvent,
  toolStartFact?: string,
): string {
  const resultText = extractTextContent(event.content);
  return [
    "event=tool_end",
    toolStartFact?.replace("event=tool_start\n", ""),
    factField("toolName", event.toolName),
    `isError=${String(event.isError)}`,
    resultText ? factField("result", resultText, MAX_FACT_CHARS) : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function finalFact(message: AssistantMessage): string | undefined {
  switch (message.stopReason) {
    case "toolUse":
      return undefined;
    case "error":
    case "aborted":
    case "length":
      return [
        "event=message_end",
        `stopReason=${message.stopReason}`,
        message.errorMessage
          ? factField("errorMessage", message.errorMessage)
          : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "stop": {
      const finalText = extractTextContent(message.content);
      return [
        "event=message_end",
        "stopReason=stop",
        finalText
          ? factField(
              "finalResultContext",
              finalText,
              FINAL_RESULT_CONTEXT_CHARS,
            )
          : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    }
    default:
      return undefined;
  }
}

function resetFacts(state: RuntimeState, prompt?: string): void {
  state.prompt = truncateText(stripAnsi(prompt ?? ""), MAX_PROMPT_CHARS);
  state.activity.splice(0);
}

function addFact(state: RuntimeState, fact: string): void {
  if (!fact || state.activity[state.activity.length - 1] === fact) return;

  state.activity.push(fact);
  if (state.activity.length > MAX_ACTIVITY_HISTORY) {
    state.activity.splice(0, state.activity.length - MAX_ACTIVITY_HISTORY);
  }
}

function factsSnapshot(state: RuntimeState): string {
  const promptLine = state.prompt ? `prompt=${state.prompt}` : undefined;
  const activityBudget =
    MAX_FACT_CHARS - (promptLine ? promptLine.length + 1 : 0);
  const recentActivity: string[] = [];
  let remaining = Math.max(0, activityBudget);

  for (
    let index = state.activity.length - 1;
    index >= 0 && remaining > 0;
    index--
  ) {
    const fact = state.activity[index];
    if (!fact) continue;

    const separatorLength = recentActivity.length === 0 ? 0 : 1;
    const needed = fact.length + separatorLength;
    if (needed <= remaining) {
      recentActivity.unshift(fact);
      remaining -= needed;
      continue;
    }

    if (recentActivity.length === 0)
      recentActivity.unshift(truncateText(fact, remaining));
    break;
  }

  return [promptLine, recentActivity.join("\n") || undefined]
    .filter((item): item is string => item !== undefined)
    .join("\n");
}

function looksLikeStructuredData(text: string): boolean {
  const trimmed = text.trim();
  return (
    ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) &&
    STRUCTURED_TOKEN_PATTERN.test(trimmed)
  );
}

function hasInvalidSummaryFormat(rawText: string, summary: string): boolean {
  const raw = rawText.trim();
  return (
    !raw ||
    SUMMARY_FORMAT_PATTERN.test(raw) ||
    SUMMARY_FORMAT_PATTERN.test(summary) ||
    looksLikeStructuredData(raw) ||
    looksLikeStructuredData(summary) ||
    summary.length > MAX_SUMMARY_CHARS
  );
}

function extractSummary(response: string): string | undefined {
  const lines = response.trim().split(/\r?\n/);
  if (lines.length !== 1) return undefined;

  const rawLine = lines[0] ?? "";
  const summary = normalizeText(stripAnsi(rawLine));
  return summary && !hasInvalidSummaryFormat(rawLine, summary)
    ? summary
    : undefined;
}

async function getFastModelAuth(
  ctx: ExtensionContext,
  preferredModel?: ModelCandidate,
): Promise<FastModelAuth | undefined> {
  for (const candidate of modelCandidates(preferredModel)) {
    const model = ctx.modelRegistry.find(candidate.provider, candidate.id);
    if (!model) continue;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok && auth.apiKey)
      return { model, apiKey: auth.apiKey, headers: auth.headers };
  }
  return undefined;
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
  urgency: Urgency,
): void {
  if (!ctx.hasUI) return;

  const facts = factsSnapshot(state);
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
          text: `Current event facts:\n${truncateText(request.facts, MAX_FACT_CHARS)}`,
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
    const summary = extractSummary(responseText);
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

        const choice = await selectTldrModel(ctx, state);
        if (!choice) return;
        value = choice;
      }

      if (value === AUTOMATIC_MODEL_CHOICE || value === "reset") {
        state.preferredModel = undefined;
        state.lastFacts = "";
        requestRefinement(ctx, state, "now");
        const result = clearPreferredModel();
        notifyUser(
          ctx,
          result.ok
            ? "pi-tldr model set to auto"
            : `pi-tldr model set to auto, but ${result.message}`,
          "info",
        );
        return;
      }

      const nextModel = parseSupportedModelSpec(value);
      if (!nextModel) {
        notifyUser(
          ctx,
          `Use one of the supported pi-tldr models: ${supportedModelList()}`,
          "error",
        );
        return;
      }

      state.preferredModel = nextModel;
      state.lastFacts = "";
      requestRefinement(ctx, state, "now");
      const result = savePreferredModel(nextModel);
      notifyUser(
        ctx,
        result.ok
          ? `pi-tldr model set to ${formatModelSpec(nextModel)}`
          : `pi-tldr model set to ${formatModelSpec(nextModel)}, but ${result.message}`,
        "info",
      );
    },
  });

  pi.on("session_start", (event, ctx) => {
    void event;
    state.generation++;
    state.active = true;
    clearPendingWork(state);
    resetFacts(state);
    state.currentSummary = "";
    state.lastFacts = "";
    state.toolFactById.clear();
    state.preferredModel =
      parseModelFlag(pi.getFlag(TLDR_MODEL_FLAG)) ?? loadPreferredModel();
    clearWidget(ctx);
  });

  pi.on("session_shutdown", () => {
    state.active = false;
    state.generation++;
    clearPendingWork(state);
    resetFacts(state);
    state.toolFactById.clear();
  });

  pi.on("before_agent_start", (event, ctx) => {
    state.generation++;
    clearPendingWork(state);
    resetFacts(state, event.prompt);
    state.currentSummary = "";
    state.lastFacts = "";
    state.toolFactById.clear();
    clearWidget(ctx);
    requestRefinement(ctx, state, "now");
  });

  pi.on("message_update", (event, ctx) => {
    if (!isAssistantMessage(event.message)) return;

    const assistantText = extractTextContent(event.message.content);
    if (!assistantText) return;

    addFact(
      state,
      ["event=message_update", factField("assistantText", assistantText)].join(
        "\n",
      ),
    );
    requestRefinement(ctx, state, "debounced");
  });

  pi.on("tool_call", (event, ctx) => {
    const fact = toolCallFact(event);
    state.toolFactById.set(event.toolCallId, fact);
    addFact(state, fact);
    requestRefinement(ctx, state, "now");
  });

  pi.on("tool_result", (event, ctx) => {
    const toolStartFact = state.toolFactById.get(event.toolCallId);
    state.toolFactById.delete(event.toolCallId);
    addFact(state, toolResultFact(event, toolStartFact));
    requestRefinement(ctx, state, "now");
  });

  pi.on("message_end", (event, ctx) => {
    if (!isAssistantMessage(event.message)) return;

    const fact = finalFact(event.message);
    if (!fact) return;

    if (
      event.message.stopReason === "stop" &&
      !extractTextContent(event.message.content)
    ) {
      state.currentSummary = "";
      clearWidget(ctx);
    }
    state.activity.splice(0);
    addFact(state, fact);
    requestRefinement(ctx, state, "now");
  });
}

export default piTldr;
