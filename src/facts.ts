/**
 * @fileoverview Indexed activity collection for model-visible TLDR context.
 *
 * This module turns pi events into bounded, readable activity records for the
 * TLDR model. It does not redact secrets, but it caps activity text so TLDR
 * requests stay small and predictable.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
} from "@earendil-works/pi-ai";
import type {
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

const MAX_ACTIVITY_TEXT_CHARS = 1_500;
const MAX_RETAINED_RAW_ACTIVITIES = 128;

type TextSourceContent =
  | AssistantMessage["content"][number]
  | TextContent
  | ImageContent;

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";

  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars === 1) return "…";

  const retainedChars = maxChars - 1;
  const headLength = Math.ceil(retainedChars / 2);
  const tailLength = Math.floor(retainedChars / 2);

  const head = chars.slice(0, headLength).join("");
  const tail = tailLength > 0 ? chars.slice(-tailLength).join("") : "";
  return `${head}…${tail}`;
}

/** The source event represented by a TLDR activity record. */
export type TldrActivityType =
  | "user_message"
  | "assistant_update"
  | "tool_call"
  | "tool_result"
  | "assistant_final"
  | "assistant_failure";

/** How urgently a generated checkpoint for an activity may be displayed. */
export type TldrDisplayPriority = "immediate" | "normal" | "final";

/** One indexed piece of conversation activity visible to the TLDR model. */
export interface TldrActivity {
  readonly index: number;
  readonly activityType: TldrActivityType;
  readonly displayPriority: TldrDisplayPriority;
  readonly text: string;
}

/** Result of recording an assistant message-end event into TLDR facts. */
export type MessageEndRecordResult =
  | TldrActivity
  | "emptyFinalStop"
  | "ignored";

/** Narrows pi agent messages to assistant messages that can produce TLDR facts. */
function isAssistantMessage(
  message: AgentMessage,
): message is AssistantMessage {
  return "role" in message && message.role === "assistant";
}

/** Narrows mixed pi content blocks to text blocks. */
function isTextContent(content: TextSourceContent): content is TextContent {
  return content.type === "text";
}

/** Returns the string payload from a text content block. */
function textBlockValue(content: TextContent): string {
  return content.text;
}

/**
 * Joins text blocks from mixed pi content.
 *
 * @param content Message or tool-result content blocks.
 * @returns Joined text, or `undefined` when there are no text blocks.
 */
export function extractTextContent(
  content: readonly TextSourceContent[],
): string | undefined {
  const textBlocks = content.filter(isTextContent);
  return textBlocks.length > 0
    ? textBlocks.map(textBlockValue).join("\n")
    : undefined;
}

/** Converts a completed assistant message into a final-result fact. */
function finalActivityText(message: AssistantMessage): string | undefined {
  switch (message.stopReason) {
    case "toolUse":
      return undefined;
    case "error":
    case "aborted":
    case "length":
      return message.errorMessage
        ? `Assistant finished with ${message.stopReason}: ${message.errorMessage}`
        : `Assistant finished with ${message.stopReason}`;
    case "stop": {
      const finalText = extractTextContent(message.content);
      return finalText ? `Assistant final response: ${finalText}` : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Collects indexed model-visible TLDR activities for one conversation.
 *
 * Callers record pi events and request raw activity deltas by activity index.
 * Activity text is capped, but this collector does not attempt to detect or
 * redact secrets.
 */
export class TldrFactCollector {
  private nextIndex = 1;
  private readonly activities: TldrActivity[] = [];

  private addActivity(
    activityType: TldrActivityType,
    displayPriority: TldrDisplayPriority,
    text: string,
  ): TldrActivity {
    const activity = {
      index: this.nextIndex,
      activityType,
      displayPriority,
      text: truncateText(text, MAX_ACTIVITY_TEXT_CHARS),
    } satisfies TldrActivity;

    this.nextIndex++;
    this.activities.push(activity);
    if (this.activities.length > MAX_RETAINED_RAW_ACTIVITIES) {
      this.activities.splice(
        0,
        this.activities.length - MAX_RETAINED_RAW_ACTIVITIES,
      );
    }

    return activity;
  }

  /** Clears all conversation activity and restarts activity indexes. */
  resetConversation(): void {
    this.nextIndex = 1;
    this.activities.splice(0);
  }

  /** Records a new user message as an immediate TLDR activity boundary. */
  recordUserMessage(prompt: string): TldrActivity {
    return this.addActivity(
      "user_message",
      "immediate",
      `User message: ${prompt}`,
    );
  }

  /**
   * Records assistant streaming/update text as in-progress activity.
   *
   * @param message Pi message update event payload.
   * @returns The recorded TLDR activity, or undefined for non-assistant/empty messages.
   */
  recordAssistantUpdate(message: AgentMessage): TldrActivity | undefined {
    if (!isAssistantMessage(message)) return undefined;

    const assistantText = extractTextContent(message.content);
    if (!assistantText) return undefined;

    return this.addActivity(
      "assistant_update",
      "normal",
      `Assistant update: ${assistantText}`,
    );
  }

  /** Records a tool call as generic tool activity. */
  recordToolCall(event: ToolCallEvent): TldrActivity {
    return this.addActivity(
      "tool_call",
      "normal",
      `Tool started: ${event.toolName}`,
    );
  }

  /** Records a tool result as generic result activity. */
  recordToolResult(event: ToolResultEvent): TldrActivity {
    const resultText = extractTextContent(event.content);
    return this.addActivity(
      "tool_result",
      "normal",
      resultText
        ? `Tool finished: ${event.toolName} (${event.isError ? "error" : "ok"})\n${resultText}`
        : `Tool finished: ${event.toolName} (${event.isError ? "error" : "ok"})`,
    );
  }

  /**
   * Records or clears final assistant activity.
   *
   * @param message Final pi agent message.
   * @returns The recorded activity, `emptyFinalStop`, or `ignored`.
   */
  recordMessageEnd(message: AgentMessage): MessageEndRecordResult {
    if (!isAssistantMessage(message)) return "ignored";

    const text = finalActivityText(message);
    if (!text) {
      if (message.stopReason !== "stop") return "ignored";
      return "emptyFinalStop";
    }

    return this.addActivity(
      message.stopReason === "stop" ? "assistant_final" : "assistant_failure",
      "final",
      text,
    );
  }

  /** Returns recorded activities after `previousIndex` through `throughIndex`. */
  activitiesAfter(
    previousIndex: number,
    throughIndex: number,
  ): readonly TldrActivity[] {
    return this.activities.filter(
      (activity) =>
        activity.index > previousIndex && activity.index <= throughIndex,
    );
  }

  /** Returns the latest activity index recorded in this conversation. */
  latestActivityIndex(): number {
    return this.nextIndex - 1;
  }

  /** Discards raw activity already covered by an accepted TLDR checkpoint. */
  discardActivitiesThrough(activityIndex: number): void {
    const firstRetainedIndex = this.activities.findIndex(
      (activity) => activity.index > activityIndex,
    );

    if (firstRetainedIndex === -1) {
      this.activities.splice(0);
      return;
    }

    if (firstRetainedIndex > 0) {
      this.activities.splice(0, firstRetainedIndex);
    }
  }
}
