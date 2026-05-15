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
import { showWidget } from "./tui.js";

const PROMPT_TARGET_SUMMARY_CHARS = 80;
const MAX_CONTEXT_CHECKPOINTS = 8;
const TLDR_MAX_TOKENS = 120;
const TLDR_REQUEST_TIMEOUT_MS = 2_000;

/** Default interval used to throttle ordinary widget display updates. */
export const DEFAULT_DISPLAY_UPDATE_INTERVAL_MS = 1_200;

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

export interface TldrCheckpointEngineOptions {
  /** Activity log that supplies raw delta context and accepts pruning. */
  readonly facts: TldrFactCollector;
  /** Model call used to ask the TLDR model for text. */
  readonly generateTldr: TldrModelCall;
  /** Monotonic clock used for TLDR scheduling decisions. */
  readonly now: TldrClock;
  /** Interval used to throttle ordinary widget display updates. */
  readonly displayUpdateIntervalMs: number;
  /** Timer scheduler; overridden by tests for deterministic execution. */
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
  };

  constructor(options: TldrCheckpointEngineOptions) {
    this.facts = options.facts;
    this.generateTldr = options.generateTldr;
    this.now = options.now;
    this.displayUpdateIntervalMs = options.displayUpdateIntervalMs;
    this.scheduler = options.scheduler;
  }

  /** Model configured through pi settings, or undefined for automatic choice. */
  selectedModel(): TldrModelPreference | undefined {
    return this.configuredModel;
  }

  /** Updates the model preference used by future checkpoint requests. */
  selectModel(model?: TldrModelPreference): void {
    this.configuredModel = model;
  }

  /** Starts a new conversation-level TLDR run and invalidates stale model work. */
  startFreshRun(): void {
    this.work.runId++;
    this.discardCurrentTldr();
  }

  /** Enqueues a checkpoint generation job for one recorded activity. */
  enqueue(ctx: ExtensionContext, activity: TldrActivity): void {
    if (!ctx.hasUI) return;

    const job = {
      activityIndex: activity.index,
      displayPriority: activity.displayPriority,
      runId: this.work.runId,
    } satisfies TldrCheckpointJob;

    if (job.displayPriority === "immediate") {
      this.clearPendingDisplay();
      this.forgetRenderedText();
      this.work.checkpointQueue.splice(0);
      this.abortInFlightCheckpoint();
      this.work.checkpointQueue.push(job);
    } else if (job.displayPriority === "final") {
      this.clearPendingDisplay();
      this.removeQueuedNormalCheckpoints();
      this.abortInFlightNormalCheckpoint();
      this.work.checkpointQueue.push(job);
    } else {
      this.replaceQueuedNormalCheckpoint(job);
    }

    this.pumpCheckpointGeneration(ctx);
  }

  /** Clears all TLDR state for a run that should no longer show a TLDR. */
  private discardCurrentTldr(): void {
    this.cancelCheckpointWork();
    this.work.latestAcceptedActivityIndex = 0;
    this.work.lastRenderedActivityIndex = 0;
    this.work.lastRenderedTldr = "";
    this.work.lastDisplayAt = Number.NEGATIVE_INFINITY;
    this.work.acceptedCheckpoints.splice(0);
    this.work.pendingDisplayCheckpoint = undefined;
  }

  /** Cancels queued and in-flight checkpoint work. */
  private cancelCheckpointWork(): void {
    this.clearDisplayTimer();
    this.work.checkpointQueue.splice(0);
    this.work.inFlightCheckpoint = undefined;
    this.work.abortController?.abort();
    this.work.abortController = undefined;
  }

  /** Clears any delayed normal checkpoint waiting for display. */
  private clearPendingDisplay(): void {
    this.clearDisplayTimer();
    this.work.pendingDisplayCheckpoint = undefined;
  }

  /** Allows a new user turn to display the same TLDR text again if regenerated. */
  private forgetRenderedText(): void {
    this.work.lastRenderedTldr = "";
  }

  /** Cancels the pending display timer, if one exists. */
  private clearDisplayTimer(): void {
    if (this.work.displayTimer === undefined) return;

    this.scheduler.clearTimeout(this.work.displayTimer);
    this.work.displayTimer = undefined;
  }

  /** Removes queued normal checkpoints that have been superseded. */
  private removeQueuedNormalCheckpoints(): void {
    this.work.checkpointQueue = this.work.checkpointQueue.filter(
      (job) => job.displayPriority !== "normal",
    );
  }

  /** Replaces any queued normal checkpoint with the newest normal target. */
  private replaceQueuedNormalCheckpoint(job: TldrCheckpointJob): void {
    this.removeQueuedNormalCheckpoints();
    this.work.checkpointQueue.push(job);
  }

  /** Aborts the current in-flight checkpoint request, if one exists. */
  private abortInFlightCheckpoint(): void {
    if (!this.work.inFlightCheckpoint) return;

    this.work.abortController?.abort();
    this.work.abortController = undefined;
    this.work.inFlightCheckpoint = undefined;
  }

  /** Aborts in-flight normal work when a boundary checkpoint supersedes it. */
  private abortInFlightNormalCheckpoint(): void {
    const inFlight = this.work.inFlightCheckpoint;
    if (!inFlight || inFlight.displayPriority !== "normal") return;

    this.abortInFlightCheckpoint();
  }

  /** Starts the next checkpoint model call if the generation pump is idle. */
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

  /** Returns whether queued or in-flight checkpoint work still belongs here. */
  private isCurrentCheckpointJob(job: TldrCheckpointJob): boolean {
    return (
      job.runId === this.work.runId && this.work.inFlightCheckpoint === job
    );
  }

  /** Calls the TLDR model and accepts its generated checkpoint if still current. */
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
      if (!this.isCurrentCheckpointJob(job) || !auth) return;

      abortController = new AbortController();
      this.work.abortController = abortController;

      const response = await this.generateTldr(
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

      if (!this.isCurrentCheckpointJob(job)) return;
      if (response.stopReason !== "stop") return;

      const text = extractTextContent(response.content) ?? "";
      if (!text) return;

      const checkpoint = {
        activityIndex: job.activityIndex,
        displayPriority: job.displayPriority,
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

  /** Accepts a generated checkpoint as compressed context for future prompts. */
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

  /** Applies display policy to an accepted generated checkpoint. */
  private considerDisplayingCheckpoint(
    ctx: ExtensionContext,
    checkpoint: TldrCheckpoint,
  ): void {
    if (checkpoint.activityIndex <= this.work.lastRenderedActivityIndex) return;
    if (checkpoint.activityIndex !== this.facts.latestActivityIndex()) return;

    if (
      checkpoint.displayPriority !== "normal" ||
      !this.work.lastRenderedTldr
    ) {
      this.clearPendingDisplay();
      this.renderCheckpoint(ctx, checkpoint);
      return;
    }

    const elapsedMs = this.now() - this.work.lastDisplayAt;
    if (elapsedMs >= this.displayUpdateIntervalMs) {
      this.clearPendingDisplay();
      this.renderCheckpoint(ctx, checkpoint);
      return;
    }

    this.work.pendingDisplayCheckpoint = checkpoint;
    if (this.work.displayTimer !== undefined) return;

    this.work.displayTimer = this.scheduler.setTimeout(() => {
      this.work.displayTimer = undefined;
      const pendingCheckpoint = this.work.pendingDisplayCheckpoint;
      this.work.pendingDisplayCheckpoint = undefined;
      if (!pendingCheckpoint) return;
      if (
        pendingCheckpoint.activityIndex !== this.facts.latestActivityIndex()
      ) {
        return;
      }

      this.renderCheckpoint(ctx, pendingCheckpoint);
    }, this.displayUpdateIntervalMs - elapsedMs);
  }

  /** Renders an accepted checkpoint. */
  private renderCheckpoint(
    ctx: ExtensionContext,
    checkpoint: TldrCheckpoint,
  ): void {
    if (checkpoint.activityIndex <= this.work.lastRenderedActivityIndex) return;
    if (checkpoint.text === this.work.lastRenderedTldr) return;

    this.work.lastRenderedActivityIndex = checkpoint.activityIndex;
    this.work.lastRenderedTldr = checkpoint.text;
    this.work.lastDisplayAt = this.now();
    showWidget(ctx, checkpoint.text);
  }

  /** Builds the single user message sent to the TLDR model for a checkpoint. */
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

/** Builds a system prompt with the checkpoint-specific tense instruction. */
function tldrSystemPrompt(tenseInstruction: string): string {
  return `You write live status TLDRs for a terminal coding agent.
Return one short, complete, plain-English sentence under ${PROMPT_TARGET_SUMMARY_CHARS} characters.
The sentence must be complete and must not trail off.
Describe what the agent is doing right now for the user's task.
Use previous generated TLDR checkpoints as compressed context.
Use new raw activity to update the status through the requested activity.
${tenseInstruction}
Do not use first person.
Do not address the user directly.
Do not speak as the assistant.
Do not output JSON, markdown, code, logs, diffs, XML, bullet points, or quoted strings.
Do not mention tool names, command names, raw arguments, or individual file names.
Output only the TLDR sentence.`;
}

/** Builds the system prompt sent to the TLDR model for a checkpoint. */
function checkpointSystemPrompt(job: TldrCheckpointJob): string {
  const tenseInstruction =
    job.displayPriority === "final"
      ? FINAL_TLDR_INSTRUCTION
      : IN_PROGRESS_TLDR_INSTRUCTION;

  return tldrSystemPrompt(tenseInstruction);
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
