/**
 * @fileoverview Rolling generated TLDR checkpoint engine.
 *
 * This module owns the full generated-checkpoint state machine: job coalescing,
 * stale-work invalidation, model prompting, accepted checkpoint context, and
 * throttled widget rendering. Its interface is intentionally narrow so the pi
 * event adapter only reports activity boundaries and session/model changes.
 */
import { complete } from "@earendil-works/pi-ai";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  extractTextContent,
  TldrFactCollector,
  type TldrActivity,
  type TldrDisplayPriority,
} from "./facts.js";
import { getFastModelAuth, type TldrModelPreference } from "./models.js";
import { sanitizeTldrText } from "./sanitize.js";
import { clearNoModelWarning, showNoModelWarning, showWidget } from "./tui.js";

const PROMPT_TARGET_SUMMARY_CHARS = 80;
const MAX_CONTEXT_CHECKPOINTS = 8;
const TLDR_MAX_TOKENS = 120;
const TLDR_REQUEST_TIMEOUT_MS = 2_000;
const TOOL_PROGRESS_DISPLAY_UPDATE_INTERVAL_MS = 10_000;

/**
 * Detect user locale from OS environment variables.
 * Returns a BCP 47-like tag (e.g. "zh-CN", "ja", "ko") or undefined.
 */
function detectLocale(): string | undefined {
  const candidates = [
    process.env.PI_LOCALE,
    process.env.LC_ALL,
    process.env.LANG,
  ].filter(Boolean) as string[];

  for (const raw of candidates) {
    const s = raw.trim();
    if (!s) continue;
    // Strip encoding suffix: "zh_CN.UTF-8" -> "zh_CN" -> "zh-CN"
    const base = s.split(".")[0]!.replace(/_/g, "-");
    if (base) return base;
  }
  return undefined;
}

/**
 * Map locale tag to an output-language instruction for the TLDR model.
 * Returns empty string for English/unknown locales (keep default English behavior).
 */
function languageInstructionForLocale(locale: string | undefined): string {
  if (!locale) return "";
  const lang = locale.split("-")[0]?.toLowerCase() ?? "";
  const region = locale.split("-")[1]?.toUpperCase() ?? "";
  switch (lang) {
    case "zh":
      // Distinguish Simplified vs Traditional by region
      if (region === "TW" || region === "HK") {
        return "Output in Traditional Chinese (繁體中文). ";
      }
      return "Output in Simplified Chinese (简体中文). ";
    case "ja":
      return "Output in Japanese (日本語). ";
    case "ko":
      return "Output in Korean (한국어). ";
    case "de":
      return "Output in German (Deutsch). ";
    case "fr":
      return "Output in French (Français). ";
    case "es":
      return "Output in Spanish (Español). ";
    case "pt":
      return "Output in Portuguese (Português). ";
    case "ru":
      return "Output in Russian (Русский). ";
    case "ar":
      return "Output in Arabic (العربية). ";
    default:
      return "";
  }
}

// Ordinary activity should feel responsive without turning rapid read/grep/edit
// bursts into a model-request ticker. The quiet window catches short bursts;
// the max wait ensures continuous activity still surfaces progress.
const NORMAL_CHECKPOINT_QUIET_MS = 700;
const NORMAL_CHECKPOINT_MAX_WAIT_MS = 2_500;

export const DEFAULT_DISPLAY_UPDATE_INTERVAL_MS = 1_200;

const IN_PROGRESS_TLDR_INSTRUCTION = "Start with a present-tense -ing verb.";
const COMPLETED_TLDR_INSTRUCTION = "Start with a past-tense verb.";

export type TldrModelCall = typeof complete;
export type TldrClock = () => number;

// Timer handles differ between Node and fake test schedulers, so the engine
// treats them as opaque tokens and keeps scheduling policy injectable.
export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface TldrCheckpointJob {
  readonly activityIndex: number;
  readonly activityType: TldrActivity["activityType"];
  readonly displayPriority: TldrDisplayPriority;
  readonly progressGroup?: string;
  readonly runId: number;
}

interface TldrCheckpoint {
  readonly activityIndex: number;
  readonly activityType: TldrActivity["activityType"];
  readonly displayPriority: TldrDisplayPriority;
  readonly progressGroup?: string;
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
  pendingNormalCheckpoint?: TldrCheckpointJob;
  normalCheckpointTimer?: unknown;
  normalCheckpointBurstStartedAt?: number;
  lastRenderedProgressGroup?: string;
  abortController?: AbortController;
  /** Detected user locale for i18n TLDR output */
  readonly locale: string | undefined;
}

export interface TldrCheckpointEngineOptions {
  readonly facts: TldrFactCollector;
  readonly generateTldr: TldrModelCall;
  readonly now: TldrClock;
  readonly displayUpdateIntervalMs: number;
  readonly scheduler: TimerScheduler;
}

export function createDefaultTimerScheduler(): TimerScheduler {
  return {
    setTimeout(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    clearTimeout(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

/**
 * Deep module for generated TLDR checkpoint orchestration.
 *
 * Callers report session/model changes and newly recorded activities. The
 * engine hides queue policy, cancellation, checkpoint prompt construction,
 * currentness checks, and rendering cadence.
 */
export class TldrCheckpointEngine {
  private readonly facts: TldrFactCollector;
  private readonly generateTldr: TldrModelCall;
  private readonly now: TldrClock;
  private readonly displayUpdateIntervalMs: number;
  private readonly scheduler: TimerScheduler;
  private configuredModel?: TldrModelPreference;
  private readonly work: TldrWorkState = {
    runId: 0,
    latestAcceptedActivityIndex: 0,
    lastRenderedActivityIndex: 0,
    lastRenderedTldr: "",
    lastDisplayAt: Number.NEGATIVE_INFINITY,
    checkpointQueue: [],
    acceptedCheckpoints: [],
    locale: detectLocale(),
  };

  constructor(options: TldrCheckpointEngineOptions) {
    this.facts = options.facts;
    this.generateTldr = options.generateTldr;
    this.now = options.now;
    this.displayUpdateIntervalMs = options.displayUpdateIntervalMs;
    this.scheduler = options.scheduler;
  }

  selectedModel(): TldrModelPreference | undefined {
    return this.configuredModel;
  }

  selectModel(model?: TldrModelPreference): void {
    this.configuredModel = model;
  }

  startFreshRun(): void {
    this.work.runId++;
    this.discardCurrentTldr();
  }

  enqueue(ctx: ExtensionContext, activity: TldrActivity): void {
    if (!ctx.hasUI) return;

    const job = {
      activityIndex: activity.index,
      activityType: activity.activityType,
      displayPriority: activity.displayPriority,
      progressGroup: activity.progressGroup,
      runId: this.work.runId,
    } satisfies TldrCheckpointJob;

    if (job.displayPriority === "immediate") {
      this.clearPendingDisplay();
      this.clearPendingNormalCheckpoint();
      this.forgetRenderedText();
      this.work.checkpointQueue.splice(0);
      this.abortInFlightCheckpoint();
      this.work.checkpointQueue.push(job);
    } else if (job.displayPriority === "final") {
      this.clearPendingDisplay();
      this.clearPendingNormalCheckpoint();
      this.removeQueuedNormalCheckpoints();
      this.abortInFlightNormalCheckpoint();
      this.work.checkpointQueue.push(job);
    } else {
      this.scheduleNormalCheckpoint(ctx, job);
      return;
    }

    this.pumpCheckpointGeneration(ctx);
  }

  private discardCurrentTldr(): void {
    this.cancelCheckpointWork();
    this.work.latestAcceptedActivityIndex = 0;
    this.work.lastRenderedActivityIndex = 0;
    this.work.lastRenderedTldr = "";
    this.work.lastDisplayAt = Number.NEGATIVE_INFINITY;
    this.work.lastRenderedProgressGroup = undefined;
    this.work.acceptedCheckpoints.splice(0);
    this.work.pendingDisplayCheckpoint = undefined;
  }

  private cancelCheckpointWork(): void {
    this.clearDisplayTimer();
    this.clearPendingNormalCheckpoint();
    this.work.checkpointQueue.splice(0);
    this.work.inFlightCheckpoint = undefined;
    this.work.abortController?.abort();
    this.work.abortController = undefined;
  }

  private clearPendingDisplay(): void {
    this.clearDisplayTimer();
    this.work.pendingDisplayCheckpoint = undefined;
  }

  private forgetRenderedText(): void {
    this.work.lastRenderedTldr = "";
  }

  private clearDisplayTimer(): void {
    if (this.work.displayTimer === undefined) return;

    this.scheduler.clearTimeout(this.work.displayTimer);
    this.work.displayTimer = undefined;
  }

  private clearNormalCheckpointTimer(): void {
    if (this.work.normalCheckpointTimer === undefined) return;

    this.scheduler.clearTimeout(this.work.normalCheckpointTimer);
    this.work.normalCheckpointTimer = undefined;
  }

  private clearPendingNormalCheckpoint(): void {
    this.clearNormalCheckpointTimer();
    this.work.pendingNormalCheckpoint = undefined;
    this.work.normalCheckpointBurstStartedAt = undefined;
  }

  private scheduleNormalCheckpoint(
    ctx: ExtensionContext,
    job: TldrCheckpointJob,
  ): void {
    this.work.pendingNormalCheckpoint = job;
    this.work.normalCheckpointBurstStartedAt ??= this.now();
    this.clearNormalCheckpointTimer();

    const burstStartedAt = this.work.normalCheckpointBurstStartedAt;
    const elapsedSinceBurstStarted = this.now() - burstStartedAt;
    const maxWaitRemainingMs =
      NORMAL_CHECKPOINT_MAX_WAIT_MS - elapsedSinceBurstStarted;
    const delayMs = Math.max(
      0,
      Math.min(NORMAL_CHECKPOINT_QUIET_MS, maxWaitRemainingMs),
    );

    if (delayMs === 0) {
      this.flushPendingNormalCheckpoint(ctx);
      return;
    }

    this.work.normalCheckpointTimer = this.scheduler.setTimeout(() => {
      this.work.normalCheckpointTimer = undefined;
      this.flushPendingNormalCheckpoint(ctx);
    }, delayMs);
  }

  private flushPendingNormalCheckpoint(ctx: ExtensionContext): void {
    const job = this.work.pendingNormalCheckpoint;
    this.clearPendingNormalCheckpoint();
    if (!job || job.runId !== this.work.runId) return;

    this.replaceQueuedNormalCheckpoint(job);
    this.pumpCheckpointGeneration(ctx);
  }

  private removeQueuedNormalCheckpoints(): void {
    this.work.checkpointQueue = this.work.checkpointQueue.filter(
      (job) => job.displayPriority !== "normal",
    );
  }

  private replaceQueuedNormalCheckpoint(job: TldrCheckpointJob): void {
    this.removeQueuedNormalCheckpoints();
    this.work.checkpointQueue.push(job);
  }

  private abortInFlightCheckpoint(): void {
    if (!this.work.inFlightCheckpoint) return;

    this.work.abortController?.abort();
    this.work.abortController = undefined;
    this.work.inFlightCheckpoint = undefined;
  }

  private abortInFlightNormalCheckpoint(): void {
    const inFlight = this.work.inFlightCheckpoint;
    if (!inFlight || inFlight.displayPriority !== "normal") return;

    this.abortInFlightCheckpoint();
  }

  private pumpCheckpointGeneration(ctx: ExtensionContext): void {
    if (!ctx.hasUI || this.work.inFlightCheckpoint) return;

    const job = this.work.checkpointQueue.shift();
    if (!job) return;
    if (job.runId !== this.work.runId) {
      this.pumpCheckpointGeneration(ctx);
      return;
    }
    if (job.activityIndex <= this.work.latestAcceptedActivityIndex) {
      this.pumpCheckpointGeneration(ctx);
      return;
    }

    this.work.inFlightCheckpoint = job;
    void this.runCheckpointRequest(ctx, job);
  }

  private isCurrentCheckpointJob(job: TldrCheckpointJob): boolean {
    return (
      job.runId === this.work.runId && this.work.inFlightCheckpoint === job
    );
  }

  private async runCheckpointRequest(
    ctx: ExtensionContext,
    job: TldrCheckpointJob,
  ): Promise<void> {
    if (!this.isCurrentCheckpointJob(job)) return;

    let abortController: AbortController | undefined;

    try {
      const prompt = this.checkpointPrompt(job);
      if (!prompt) return;

      const auth = await getFastModelAuth(ctx, this.configuredModel);
      if (!this.isCurrentCheckpointJob(job)) return;
      if (!auth) {
        showNoModelWarning(ctx);
        return;
      }
      clearNoModelWarning(ctx);

      abortController = new AbortController();
      this.work.abortController = abortController;

      const response = await this.generateTldr(
        auth.model,
        {
          systemPrompt: checkpointSystemPrompt(job, this.work.locale),
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

      if (!this.isCurrentCheckpointJob(job)) return;
      if (response.stopReason !== "stop") return;

      const text = sanitizeTldrText(extractTextContent(response.content) ?? "");
      if (!text) return;

      const checkpoint = {
        activityIndex: job.activityIndex,
        activityType: job.activityType,
        displayPriority: job.displayPriority,
        progressGroup: job.progressGroup,
        text,
      } satisfies TldrCheckpoint;

      this.acceptCheckpoint(checkpoint);
      this.considerDisplayingCheckpoint(ctx, checkpoint);
    } catch {
      // TLDRs are best-effort; later checkpoints include unaccepted raw activity.
    } finally {
      if (abortController && this.work.abortController === abortController) {
        this.work.abortController = undefined;
      }
      if (this.work.inFlightCheckpoint === job) {
        this.work.inFlightCheckpoint = undefined;
      }
      this.pumpCheckpointGeneration(ctx);
    }
  }

  private acceptCheckpoint(checkpoint: TldrCheckpoint): void {
    this.work.acceptedCheckpoints.push(checkpoint);
    if (this.work.acceptedCheckpoints.length > MAX_CONTEXT_CHECKPOINTS) {
      this.work.acceptedCheckpoints.splice(
        0,
        this.work.acceptedCheckpoints.length - MAX_CONTEXT_CHECKPOINTS,
      );
    }
    this.work.latestAcceptedActivityIndex = checkpoint.activityIndex;
    this.facts.discardActivitiesThrough(checkpoint.activityIndex);
  }

  private considerDisplayingCheckpoint(
    ctx: ExtensionContext,
    checkpoint: TldrCheckpoint,
  ): void {
    if (checkpoint.activityIndex <= this.work.lastRenderedActivityIndex) return;
    if (this.shouldDropStaleCheckpoint(checkpoint)) return;

    if (
      checkpoint.displayPriority !== "normal" ||
      !this.work.lastRenderedTldr
    ) {
      this.clearPendingDisplay();
      this.renderCheckpoint(ctx, checkpoint);
      return;
    }

    const displayIntervalMs = this.displayIntervalFor(checkpoint);
    const elapsedMs = this.now() - this.work.lastDisplayAt;
    if (elapsedMs >= displayIntervalMs) {
      this.clearPendingDisplay();
      this.renderCheckpoint(ctx, checkpoint);
      return;
    }

    this.work.pendingDisplayCheckpoint = checkpoint;
    // Recompute the timer for each newly accepted pending checkpoint. This is
    // important when a noisy progress update scheduled a long 10s debounce but
    // a later ordinary update should render after the shorter normal interval.
    this.clearDisplayTimer();

    this.work.displayTimer = this.scheduler.setTimeout(() => {
      this.work.displayTimer = undefined;
      const pendingCheckpoint = this.work.pendingDisplayCheckpoint;
      this.work.pendingDisplayCheckpoint = undefined;
      if (!pendingCheckpoint) return;
      if (this.shouldDropStaleCheckpoint(pendingCheckpoint)) return;

      this.renderCheckpoint(ctx, pendingCheckpoint);
    }, displayIntervalMs - elapsedMs);
  }

  private shouldDropStaleCheckpoint(checkpoint: TldrCheckpoint): boolean {
    // Current checkpoints are always renderable; there is no newer activity that
    // could make their TLDR misleading.
    if (checkpoint.activityIndex === this.facts.latestActivityIndex()) {
      return false;
    }

    // Boundary checkpoints must stay latest-only. A stale prompt-start/final
    // TLDR would describe the wrong turn, so those are dropped once newer
    // activity exists.
    if (checkpoint.displayPriority !== "normal") return true;

    // Most normal checkpoints are also latest-only. The only exception is
    // noisy progress streams: a TLDR model call for chunk N may finish after
    // chunk N+1 arrives, but it is still useful while the same stream is active.
    if (!isToolProgressActivity(checkpoint.activityType)) return true;

    // A progress group identifies one continuous stream. Without it, stale
    // progress from unrelated streams could accidentally compare equal via
    // `undefined === undefined`, so missing group metadata is treated as stale.
    if (!checkpoint.progressGroup) return true;

    const latestActivity = this.facts.latestActivity();

    // Only render stale progress while the latest activity is a newer update
    // from the same stream. If the stream completed, another tool took over, or
    // ordinary assistant/tool activity arrived, the progress TLDR is obsolete.
    return !(
      latestActivity &&
      latestActivity.index > checkpoint.activityIndex &&
      latestActivity.activityType === checkpoint.activityType &&
      latestActivity.progressGroup === checkpoint.progressGroup
    );
  }

  private displayIntervalFor(checkpoint: TldrCheckpoint): number {
    if (!isToolProgressActivity(checkpoint.activityType)) {
      return this.displayUpdateIntervalMs;
    }

    return checkpoint.progressGroup &&
      checkpoint.progressGroup === this.work.lastRenderedProgressGroup
      ? TOOL_PROGRESS_DISPLAY_UPDATE_INTERVAL_MS
      : this.displayUpdateIntervalMs;
  }

  private renderCheckpoint(
    ctx: ExtensionContext,
    checkpoint: TldrCheckpoint,
  ): void {
    if (checkpoint.activityIndex <= this.work.lastRenderedActivityIndex) return;
    if (checkpoint.text === this.work.lastRenderedTldr) return;

    this.work.lastRenderedActivityIndex = checkpoint.activityIndex;
    this.work.lastRenderedTldr = checkpoint.text;
    this.work.lastDisplayAt = this.now();
    this.work.lastRenderedProgressGroup = isToolProgressActivity(
      checkpoint.activityType,
    )
      ? checkpoint.progressGroup
      : undefined;
    showWidget(ctx, checkpoint.text);
  }

  private checkpointPrompt(job: TldrCheckpointJob): UserMessage | undefined {
    const rawActivities = this.facts.activitiesAfter(
      this.work.latestAcceptedActivityIndex,
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
            previousCheckpointLines(this.work.acceptedCheckpoints),
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
}

function tldrSystemPrompt(
  tenseInstruction: string,
  locale?: string,
): string {
  const langInstr = languageInstructionForLocale(locale);
  return `Write one TLDR summary for a Pi coding agent.
${langInstr}Use the prior TLDRs for context and the new activity for the update.
Describe the work progress as if a human developer were doing it.
Focus on the task activity and current outcome, not agent mechanics.
Do not mention tools, tool calls, prompts, messages, model output, or implementation details.
Summarize only activity up to the requested index.
If context is sparse, still summarize the available activity.
Never ask for more information or say there is not enough context.
Return exactly one complete sentence under ${PROMPT_TARGET_SUMMARY_CHARS} characters.
Use third person. Do not address the user.
Plain text only; no markdown, JSON, code, bullets, quotes, or file/tool names.
${tenseInstruction}`;
}

function checkpointSystemPrompt(
  job: TldrCheckpointJob,
  locale?: string,
): string {
  const tenseInstruction = usesCompletedTense(job.activityType)
    ? COMPLETED_TLDR_INSTRUCTION
    : IN_PROGRESS_TLDR_INSTRUCTION;

  return tldrSystemPrompt(tenseInstruction, locale);
}

function usesCompletedTense(
  activityType: TldrActivity["activityType"],
): boolean {
  return (
    activityType === "tool_input_end" ||
    activityType === "tool_execution_end" ||
    activityType === "tool_result" ||
    activityType === "assistant_final" ||
    activityType === "assistant_failure"
  );
}

function isToolProgressActivity(
  activityType: TldrActivity["activityType"],
): boolean {
  return (
    activityType === "tool_input_update" ||
    activityType === "tool_execution_update"
  );
}

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

function formatRawActivity(activity: TldrActivity): string {
  return `[${activity.index}] ${activity.activityType}: ${activity.text}`;
}
