/**
 * pi-tldr extension.
 *
 * Shows a compact live summary box above the input editor. It renders only
 * fast-LLM TLDR output, using agent events as facts.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Api, complete, type Model, type UserMessage } from "@mariozechner/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	ModelSelectorComponent,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

/**
 * Widget/display settings. The widget key is stable so later updates replace
 * the same UI box instead of creating multiple boxes.
 */
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
const LLM_UPDATE_INTERVAL_MS = 1_200;
const TLDR_MAX_TOKENS = 80;

type ModelCandidate = { provider: string; id: string };
type ModelSelectorSettings = ConstructorParameters<typeof ModelSelectorComponent>[2];
type ModelSelectorRegistry = ConstructorParameters<typeof ModelSelectorComponent>[3];

/**
 * Confirmed working TLDR models in automatic preference order. Haiku stays first
 * because TLDR generation should prefer fast, inexpensive models when available.
 */
const FAST_MODEL_CANDIDATES: ReadonlyArray<ModelCandidate> = [
	{ provider: "anthropic", id: "claude-haiku-4-5" },
	{ provider: "anthropic", id: "claude-haiku-4-5-20251001" },
	{ provider: "anthropic", id: "claude-sonnet-4-5" },
	{ provider: "anthropic", id: "claude-sonnet-4-5-20250929" },
	{ provider: "anthropic", id: "claude-sonnet-4-6" },
	{ provider: "anthropic", id: "claude-opus-4-1" },
	{ provider: "anthropic", id: "claude-opus-4-1-20250805" },
	{ provider: "anthropic", id: "claude-opus-4-5" },
	{ provider: "anthropic", id: "claude-opus-4-5-20251101" },
	{ provider: "anthropic", id: "claude-opus-4-6" },
	{ provider: "anthropic", id: "claude-opus-4-7" },
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

const MODEL_SELECTOR_SETTINGS = {
	setDefaultModelAndProvider() {
		// pi-tldr stores its own model preference instead of changing pi's default model.
	},
} as unknown as ModelSelectorSettings;

/**
 * The only place that shapes visible TLDR wording. The code validates output
 * format; it does not maintain phrase-specific fallbacks.
 */
const TLDR_SYSTEM_PROMPT = `You write live status TLDRs for a terminal coding agent.
Return one short, complete, plain-English sentence.
The sentence must be complete and must not trail off.
Describe the current workflow step for the user's task.
For in-progress work, start with a present-tense action verb form ending in -ing.
For final results or completed work, start with a past-tense action verb.
For final-result context, summarize what was accomplished instead of quoting or paraphrasing the response.
Be specific enough to show progress, but do not mention individual files, raw tool arguments, or tiny edits.
Do not use first person.
Do not address the user directly.
Do not speak as the assistant.
Do not output JSON, markdown, code, raw logs, raw diffs, XML, bullet points, or quoted strings.
Do not mention tool names, command names, or raw arguments.
Do not say generic phrases like "working", "thinking", "processing", "using a tool", "running a command", or "reviewing code".
Do not mention that you are an AI, and do not add punctuation beyond the sentence.
Output only the TLDR sentence. It must be short and complete.`;

type FastModelAuth = {
	model: Model<Api>;
	apiKey: string;
	headers?: Record<string, string>;
};

/**
 * All mutable state for the extension. Event handlers mutate this object as
 * simple state transitions; helpers do not own hidden state outside it.
 */
type RuntimeState = {
	active: boolean;
	/** User-selected model tried before the default candidate list. */
	preferredModel: ModelCandidate | undefined;
	/** Lets async LLM calls detect that the session/request changed before rendering. */
	generation: number;
	/** Invalidates older LLM calls within the same request when newer facts arrive. */
	refinementGeneration: number;
	prompt: string;
	activity: string[];
	currentSummary: string;
	lastFacts: string;
	lastLlmStart: number;
	pendingFacts: string | undefined;
	updateTimer: ReturnType<typeof setTimeout> | undefined;
	activeRequest: AbortController | undefined;
	toolArgsById: Map<string, unknown>;
};

/**
 * Captured when an LLM request starts. The generation numbers let the response
 * prove it still belongs to the latest session/request before it renders.
 */
type RefinementRequest = {
	facts: string;
	generation: number;
	refinementGeneration: number;
};

type Urgency = "debounced" | "now";

/**
 * Small presentation-only component. All TLDR policy lives outside the TUI layer.
 */
class PiTldrBox implements Component {
	constructor(
		private readonly theme: Theme,
		private readonly summary: string,
	) {}

	invalidate(): void {
		// Stateless: render uses the current theme proxy and summary.
	}

	render(width: number): string[] {
		if (width < MIN_BOX_WIDTH) return [`${TITLE.trim()}: ${this.summary}`];

		const contentWidth = width - 4;
		const lines = wrapTextWithAnsi(this.summary, contentWidth);
		return [
			this.topBorder(width),
			...(lines.length === 0 ? [""] : lines).map((line) => this.contentLine(line, contentWidth)),
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

/**
 * Creates the state object used by all handlers for one extension instance.
 */
function createInitialState(): RuntimeState {
	return {
		active: false,
		preferredModel: undefined,
		generation: 0,
		refinementGeneration: 0,
		prompt: "",
		activity: [],
		currentSummary: "",
		lastFacts: "",
		lastLlmStart: 0,
		pendingFacts: undefined,
		updateTimer: undefined,
		activeRequest: undefined,
		toolArgsById: new Map(),
	};
}

/**
 * Clears the TLDR widget when a TUI is available.
 */
function clearWidget(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
}

/**
 * Renders text that has already passed extractSummary()/renderSummary(). Keeping
 * validation out of this function makes the rendering boundary small.
 */
function showWidget(ctx: ExtensionContext, summary: string): void {
	if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => new PiTldrBox(theme, summary));
}

/**
 * Collapses whitespace for both visible summaries and internal fact payloads.
 */
function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars?: number): string {
	const normalized = normalizeText(text);
	if (maxChars === undefined) return normalized;
	return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function looksLikeStructuredData(text: string): boolean {
	const trimmed = text.trim();
	return (
		((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) &&
		/[{}[\]":,]/.test(trimmed)
	);
}

/**
 * Narrows unknown extension event payload values before reading fields.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function safeJsonPreview(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function extractAssistantText(message: { content?: unknown } | undefined): string | undefined {
	if (!Array.isArray(message?.content)) return undefined;

	const text = message.content
		.map((item) => {
			const content = asRecord(item);
			return content?.type === "text" && typeof content.text === "string" ? content.text : undefined;
		})
		.filter((item): item is string => item !== undefined)
		.join("\n")
		.trim();

	return text || undefined;
}

/**
 * Converts opaque tool args/results into compact model facts. Unlike visible
 * summaries, facts may be JSON, so punctuation and field names are preserved.
 */
function compactEventFacts(value: unknown): string {
	return truncateText(stripAnsi(safeJsonPreview(value)), MAX_FACT_CHARS);
}

function formatModelSpec(candidate: ModelCandidate): string {
	return `${candidate.provider}/${candidate.id}`;
}

function formatRegistryModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function parseModelSpec(value: unknown): ModelCandidate | undefined {
	if (typeof value !== "string") return undefined;

	const trimmed = value.trim();
	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator === trimmed.length - 1) return undefined;

	return {
		provider: trimmed.slice(0, separator),
		id: trimmed.slice(separator + 1),
	};
}

function isSupportedTldrModel(candidate: ModelCandidate): boolean {
	return FAST_MODEL_CANDIDATES.some((supported) => formatModelSpec(supported) === formatModelSpec(candidate));
}

function parseSupportedModelSpec(value: unknown): ModelCandidate | undefined {
	const candidate = parseModelSpec(value);
	return candidate && isSupportedTldrModel(candidate) ? candidate : undefined;
}

function supportedModelList(): string {
	return FAST_MODEL_CANDIDATES.map(formatModelSpec).join(", ");
}

function modelCandidates(preferredModel?: ModelCandidate): ReadonlyArray<ModelCandidate> {
	if (!preferredModel) return FAST_MODEL_CANDIDATES;

	return [
		preferredModel,
		...FAST_MODEL_CANDIDATES.filter((candidate) => formatModelSpec(candidate) !== formatModelSpec(preferredModel)),
	];
}

function tldrConfigPath(): string {
	return join(getAgentDir(), TLDR_MODEL_CONFIG_FILE);
}

/**
 * Global extension preference stored outside session history. Pi has session
 * persistence and CLI flags, but no public namespaced global settings writer.
 */
function loadPreferredModel(): ModelCandidate | undefined {
	try {
		const path = tldrConfigPath();
		if (!existsSync(path)) return undefined;

		const data = asRecord(JSON.parse(readFileSync(path, "utf8")));
		return parseSupportedModelSpec(data?.model);
	} catch {
		return undefined;
	}
}

function savePreferredModel(preferredModel: ModelCandidate): boolean {
	try {
		const path = tldrConfigPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ model: formatModelSpec(preferredModel) }, null, 2)}\n`);
		return true;
	} catch {
		return false;
	}
}

function clearPreferredModel(): boolean {
	try {
		const path = tldrConfigPath();
		if (existsSync(path)) rmSync(path);
		return true;
	} catch {
		return false;
	}
}

function isAutomaticModel(model: Model<Api>): boolean {
	return model.provider === AUTOMATIC_MODEL_PROVIDER && model.id === AUTOMATIC_MODEL_CHOICE;
}

function createModelSelectorRegistry(ctx: ExtensionContext): ModelSelectorRegistry {
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
					const availableBySpec = new Map(target.getAvailable().map((model) => [formatRegistryModel(model), model]));
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

async function selectTldrModel(ctx: ExtensionContext, state: RuntimeState): Promise<string | undefined> {
	const selectorRegistry = createModelSelectorRegistry(ctx);
	const currentModel = state.preferredModel
		? selectorRegistry.find(state.preferredModel.provider, state.preferredModel.id)
		: AUTOMATIC_TLDR_MODEL;

	const selectedModel = await ctx.ui.custom<Model<Api> | undefined>((tui, _theme, _keybindings, done) =>
		new ModelSelectorComponent(
			tui,
			currentModel,
			MODEL_SELECTOR_SETTINGS,
			selectorRegistry,
			[],
			(model) => done(model),
			() => done(undefined),
		),
	);

	if (!selectedModel) return undefined;
	return isAutomaticModel(selectedModel) ? AUTOMATIC_MODEL_CHOICE : formatRegistryModel(selectedModel);
}

/**
 * Starts a new request fact set with the user's prompt and empty activity.
 */
function resetFacts(state: RuntimeState, prompt?: string): void {
	state.prompt = truncateText(stripAnsi(prompt ?? ""), MAX_PROMPT_CHARS);
	state.activity.length = 0;
}

/**
 * Adds a deduped, bounded event fact so the TLDR model sees recent intent
 * without being overwhelmed by streaming updates or repeated tool events.
 */
function addFact(state: RuntimeState, eventName: string, fields: Record<string, string | undefined> = {}): void {
	const lines = [`event=${eventName}`];
	for (const [key, value] of Object.entries(fields)) {
		if (value) lines.push(`${key}=${value}`);
	}

	const fact = lines.join("\n");
	if (state.activity[state.activity.length - 1] === fact) return;

	state.activity.push(fact);
	if (state.activity.length > MAX_ACTIVITY_HISTORY) {
		state.activity.splice(0, state.activity.length - MAX_ACTIVITY_HISTORY);
	}
}

/**
 * Builds the exact payload sent to the TLDR model. Prompt context is kept first;
 * activity is selected from newest to oldest within the remaining budget.
 */
function factsSnapshot(state: RuntimeState): string {
	const promptLine = state.prompt ? `prompt=${state.prompt}` : undefined;
	const activityBudget = MAX_FACT_CHARS - (promptLine ? promptLine.length + 1 : 0);
	const recentActivity: string[] = [];
	let remaining = Math.max(0, activityBudget);

	// Preserve the newest facts first. Tool results arrive after tool calls, so
	// keeping the tail avoids large args crowding out what the tool discovered.
	for (let i = state.activity.length - 1; i >= 0 && remaining > 0; i--) {
		const fact = state.activity[i];
		if (!fact) continue;

		const separatorLength = recentActivity.length === 0 ? 0 : 1;
		const needed = fact.length + separatorLength;
		if (needed <= remaining) {
			recentActivity.unshift(fact);
			remaining -= needed;
			continue;
		}

		if (recentActivity.length === 0) recentActivity.unshift(truncateText(fact, remaining));
		break;
	}

	return [promptLine, recentActivity.join("\n") || undefined]
		.filter((item): item is string => item !== undefined)
		.join("\n");
}

/**
 * Validates format only. Visible wording should come from the model and prompt,
 * not hardcoded phrase checks.
 */
function hasInvalidSummaryFormat(rawText: string, summary: string): boolean {
	const raw = rawText.trim();
	const invalidFormat = /^['"`]|['"`]$|```|`|\[[^\]]+]\([^)]*\)|^\s*[-*+]\s+|^\s*#{1,6}\s+|<[^>]+>/;
	return (
		!raw ||
		invalidFormat.test(raw) ||
		invalidFormat.test(summary) ||
		looksLikeStructuredData(raw) ||
		looksLikeStructuredData(summary)
	);
}

/**
 * Converts raw LLM response text into the only thing that may become visible.
 * Returning undefined means "keep the previous accepted TLDR".
 */
function extractSummary(response: string): string | undefined {
	const lines = response.trim().split(/\r?\n/);
	if (lines.length !== 1) return undefined;

	const rawLine = lines[0] ?? "";
	const summary = normalizeText(stripAnsi(rawLine));
	return summary && !hasInvalidSummaryFormat(rawLine, summary) ? summary : undefined;
}

/**
 * Lazily finds the first configured fast model with usable auth.
 */
async function getFastModelAuth(ctx: ExtensionContext, preferredModel?: ModelCandidate): Promise<FastModelAuth | undefined> {
	for (const candidate of modelCandidates(preferredModel)) {
		const model = ctx.modelRegistry.find(candidate.provider, candidate.id);
		if (!model) continue;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok && auth.apiKey) return { model, apiKey: auth.apiKey, headers: auth.headers };
	}
	return undefined;
}

/**
 * Cancels pending work at request/session boundaries so stale TLDRs cannot render.
 */
function clearPendingWork(state: RuntimeState): void {
	if (state.updateTimer) clearTimeout(state.updateTimer);
	state.updateTimer = undefined;
	state.pendingFacts = undefined;
	state.activeRequest?.abort();
	state.activeRequest = undefined;
}

/**
 * Checks whether an async LLM result still belongs to the latest request/fact set.
 */
function isCurrent(state: RuntimeState, request: RefinementRequest): boolean {
	return (
		state.active &&
		request.generation === state.generation &&
		request.refinementGeneration === state.refinementGeneration
	);
}

/**
 * Final render gate: skips duplicate accepted summaries, then updates state/UI.
 */
function renderSummary(ctx: ExtensionContext, state: RuntimeState, summary: string): void {
	if (summary === state.currentSummary) return;

	state.currentSummary = summary;
	showWidget(ctx, summary);
}

/**
 * Schedules the next TLDR refinement. New facts replace pending facts and abort
 * active generation so older model output cannot overwrite newer state.
 */
function requestRefinement(ctx: ExtensionContext, state: RuntimeState, urgency: Urgency): void {
	if (!ctx.hasUI) return;

	const facts = factsSnapshot(state);
	if (!facts || facts === state.lastFacts) return;

	state.lastFacts = facts;
	state.pendingFacts = facts;
	state.refinementGeneration++;
	state.activeRequest?.abort();
	state.activeRequest = undefined;

	if (state.updateTimer) clearTimeout(state.updateTimer);
	const elapsedSinceLastLlm = Date.now() - state.lastLlmStart;
	const delay = urgency === "now" ? 0 : Math.max(0, LLM_UPDATE_INTERVAL_MS - elapsedSinceLastLlm);
	state.updateTimer = setTimeout(() => flushRefinement(ctx, state), delay);
}

/**
 * Timer callback that captures pending facts and starts the async LLM request.
 */
function flushRefinement(ctx: ExtensionContext, state: RuntimeState): void {
	state.updateTimer = undefined;
	const facts = state.pendingFacts;
	state.pendingFacts = undefined;
	if (!facts) return;

	void generateSummary(ctx, state, {
		facts,
		generation: state.generation,
		refinementGeneration: state.refinementGeneration,
	});
}

/**
 * Calls the fast model once. On auth/model/output failure, the extension keeps
 * the previous accepted TLDR instead of fabricating a fallback status.
 */
async function generateSummary(ctx: ExtensionContext, state: RuntimeState, request: RefinementRequest): Promise<void> {
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
			content: [{ type: "text", text: `Current event facts:\n${truncateText(request.facts, MAX_FACT_CHARS)}` }],
			timestamp: Date.now(),
		};
		const response = await complete(
			auth.model,
			{ systemPrompt: TLDR_SYSTEM_PROMPT, messages: [message] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: TLDR_MAX_TOKENS,
				maxRetries: 0,
				temperature: 0.2,
				signal: abortController.signal,
			},
		);
		if (!isCurrent(state, request) || response.stopReason !== "stop") return;

		const responseText = response.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		const summary = extractSummary(responseText);
		if (summary) renderSummary(ctx, state, summary);
	} catch {
		// Keep the previous accepted TLDR if refinement fails.
	} finally {
		if (state.activeRequest === abortController) state.activeRequest = undefined;
	}
}

/**
 * Registers pi lifecycle handlers that turn agent events into live TLDR updates.
 */
export default function piTldr(pi: ExtensionAPI) {
	pi.registerFlag(TLDR_MODEL_FLAG, {
		description: "Preferred model for pi-tldr summaries, in provider/model-id format",
		type: "string",
	});

	// State is deliberately explicit and local to this installed extension instance.
	// Read the handlers below as the lifecycle: session setup, request start,
	// streaming/tool updates, then final assistant completion.
	const state = createInitialState();

	pi.registerCommand("tldr-model", {
		description: "Choose the model used for pi-tldr summaries",
		handler: async (args, ctx) => {
			let value = args.trim();
			if (!value) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Use /tldr-model provider/model-id, /tldr-model auto, or /tldr-model reset", "error");
					return;
				}

				const choice = await selectTldrModel(ctx, state);
				if (!choice) return;
				value = choice;
			}

			if (value === AUTOMATIC_MODEL_CHOICE || value === "reset") {
				state.preferredModel = undefined;
				state.lastFacts = "";
				requestRefinement(ctx, state, "now");
				ctx.ui.notify(
					clearPreferredModel()
						? "pi-tldr model set to auto"
						: "pi-tldr model set to auto, but the saved preference could not be removed",
					"info",
				);
				return;
			}

			const nextModel = parseSupportedModelSpec(value);
			if (!nextModel) {
				ctx.ui.notify(`Use one of the supported pi-tldr models: ${supportedModelList()}`, "error");
				return;
			}

			state.preferredModel = nextModel;
			state.lastFacts = "";
			requestRefinement(ctx, state, "now");
			ctx.ui.notify(
				savePreferredModel(nextModel)
					? `pi-tldr model set to ${formatModelSpec(nextModel)}`
					: `pi-tldr model set to ${formatModelSpec(nextModel)}, but the preference could not be saved`,
				"info",
			);
		},
	});

	// A new/resumed session can reuse the loaded extension, so clear old UI and
	// invalidate any async work from a previous session generation.
	pi.on("session_start", (_event, ctx) => {
		state.generation++;
		state.active = true;
		state.currentSummary = "";
		state.preferredModel = parseSupportedModelSpec(pi.getFlag(TLDR_MODEL_FLAG)) ?? loadPreferredModel();
		clearWidget(ctx);
	});

	// Shutdown is the hard boundary: stop timers/requests and discard collected
	// facts so no stale TLDR can appear after the session is gone.
	pi.on("session_shutdown", () => {
		state.active = false;
		state.generation++;
		clearPendingWork(state);
		resetFacts(state);
		state.toolArgsById.clear();
	});

	// Each user prompt starts a new request generation. The old TLDR is cleared
	// immediately; the first new TLDR is generated from the prompt facts.
	pi.on("before_agent_start", (event, ctx) => {
		state.generation++;
		clearPendingWork(state);
		resetFacts(state, event.prompt);
		state.currentSummary = "";
		state.lastFacts = "";
		state.toolArgsById.clear();
		clearWidget(ctx);
		requestRefinement(ctx, state, "now");
	});

	// Streaming assistant text can reveal the current phase before a tool call or
	// final answer completes, so it is added as debounced context.
	pi.on("message_update", (event, ctx) => {
		const assistantText = extractAssistantText(asRecord(event.message));
		if (!assistantText) return;

		addFact(state, "message_update", { assistantText });
		requestRefinement(ctx, state, "debounced");
	});

	// Tool start gives the TLDR model intent: what operation was requested. Args
	// are also saved by id so completion can include both args and result.
	pi.on("tool_execution_start", (event, ctx) => {
		state.toolArgsById.set(event.toolCallId, event.args);
		addFact(state, "tool_execution_start", {
			toolName: event.toolName,
			args: compactEventFacts(event.args),
		});
		requestRefinement(ctx, state, "now");
	});

	// Tool end gives the TLDR model outcome: whether it failed and what came back.
	// Result is placed before repeated args in the fact so budget pressure keeps it.
	pi.on("tool_execution_end", (event, ctx) => {
		const args = state.toolArgsById.get(event.toolCallId);
		state.toolArgsById.delete(event.toolCallId);
		addFact(state, "tool_execution_end", {
			toolName: event.toolName,
			isError: String(event.isError),
			result: compactEventFacts(event.result),
			args: compactEventFacts(args),
		});
		requestRefinement(ctx, state, "now");
	});

	// Assistant message end is either an intermediate tool-use stop or the final
	// answer/error. Only final-ish states become result TLDR facts.
	pi.on("message_end", (event, ctx) => {
		const message = asRecord(event.message);
		if (message?.role !== "assistant") return;

		const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
		if (stopReason === "toolUse") return;

		if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") {
			state.activity.length = 0;
			addFact(state, "message_end", {
				stopReason,
				errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
			});
			requestRefinement(ctx, state, "now");
			return;
		}

		const assistantText = extractAssistantText(message);
		if (assistantText && stopReason === "stop") {
			state.activity.length = 0;
			addFact(state, "message_end", {
				stopReason,
				finalResultContext: truncateText(assistantText, 1_200),
			});
			requestRefinement(ctx, state, "now");
		}
	});
}
