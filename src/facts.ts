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
  AssistantMessageEvent,
  ImageContent,
  TextContent,
  ToolCall,
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

interface ToolExecutionStartActivityEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
}

interface ToolExecutionUpdateActivityEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly partialResult: unknown;
}

interface ToolExecutionEndActivityEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: unknown;
  readonly isError: boolean;
}

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
  | "tool_input_start"
  | "tool_input_update"
  | "tool_input_end"
  | "tool_call"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
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
  readonly progressGroup?: string;
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

/** Narrows arbitrary event payload fields to records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrows unknown tool payload blocks to text content. */
function isUnknownTextContent(value: unknown): value is TextContent {
  return (
    isRecord(value) && value.type === "text" && typeof value.text === "string"
  );
}

/** Narrows assistant content blocks to completed or partial tool calls. */
function isToolCallContent(value: unknown): value is ToolCall {
  return (
    isRecord(value) &&
    value.type === "toolCall" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isRecord(value.arguments)
  );
}

/** Returns the tool call currently represented by an assistant stream event. */
function toolCallAtContentIndex(
  message: AssistantMessage,
  contentIndex: number,
): ToolCall | undefined {
  const content = message.content[contentIndex];
  return isToolCallContent(content) ? content : undefined;
}

/** Extracts text blocks from unknown tool execution payload content. */
function extractTextFromUnknownContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;

  const textBlocks = content.filter(isUnknownTextContent);
  return textBlocks.length > 0
    ? textBlocks.map(textBlockValue).join("\n")
    : undefined;
}

/** Converts arbitrary tool execution payloads into bounded activity text input. */
function formatUnknownPayload(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;

  if (isRecord(value)) {
    const contentText = extractTextFromUnknownContent(value.content);
    if (contentText) return contentText;

    if (typeof value.text === "string") return value.text;
  }

  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/** Appends an optional payload on a new line. */
function appendPayload(prefix: string, payload: unknown): string {
  const payloadText = formatUnknownPayload(payload);
  return payloadText ? `${prefix}\n${payloadText}` : prefix;
}

interface ToolInputActivityResult {
  readonly activityType:
    | "tool_input_start"
    | "tool_input_update"
    | "tool_input_end";
  readonly text: string;
  readonly anchorKey?: string;
  readonly anchorText?: string;
  readonly clearAnchor?: boolean;
  readonly progressGroup?: string;
}

/** Builds a stable key for a streamed tool-call input block. */
function toolInputAnchorKey(
  contentIndex: number,
  toolCall: ToolCall | undefined,
): string {
  return toolCall?.id ?? `content:${contentIndex}`;
}

/** Formats an update as context for the original action. */
function anchoredUpdateText(anchorText: string, updateText: string): string {
  return `Main action: ${anchorText}\nUpdate context: ${updateText}`;
}

/** Builds a generic description of streamed tool-call input. */
function toolInputActivity(
  event: AssistantMessageEvent | undefined,
  activeInputs: ReadonlyMap<string, string>,
): ToolInputActivityResult | undefined {
  if (!event) return undefined;

  switch (event.type) {
    case "toolcall_start": {
      const toolCall = toolCallAtContentIndex(
        event.partial,
        event.contentIndex,
      );
      const toolName = toolCall?.name ?? "unknown tool";
      const anchorKey = toolInputAnchorKey(event.contentIndex, toolCall);
      const anchorText = appendPayload(
        `Tool input started: ${toolName}`,
        toolCall?.arguments,
      );
      return {
        activityType: "tool_input_start",
        text: anchorText,
        anchorKey,
        anchorText,
      };
    }
    case "toolcall_delta": {
      const toolCall = toolCallAtContentIndex(
        event.partial,
        event.contentIndex,
      );
      const toolName = toolCall?.name ?? "unknown tool";
      const anchorKey = toolInputAnchorKey(event.contentIndex, toolCall);
      const anchorText =
        activeInputs.get(anchorKey) ?? `Tool input started: ${toolName}`;
      const currentInput = formatUnknownPayload(toolCall?.arguments);
      const latestChunk = event.delta
        ? `Latest input chunk: ${event.delta}`
        : undefined;
      const updateText = [currentInput, latestChunk].filter(Boolean).join("\n");
      return {
        activityType: "tool_input_update",
        text: anchoredUpdateText(
          anchorText,
          updateText || `Tool input streaming: ${toolName}`,
        ),
        anchorKey,
        anchorText,
        progressGroup: `tool-input:${anchorKey}`,
      };
    }
    case "toolcall_end": {
      const anchorText =
        activeInputs.get(event.toolCall.id) ??
        `Tool input started: ${event.toolCall.name}`;
      return {
        activityType: "tool_input_end",
        text: anchoredUpdateText(
          anchorText,
          appendPayload("Tool input completed", event.toolCall.arguments),
        ),
        anchorKey: event.toolCall.id,
        clearAnchor: true,
      };
    }
    default:
      return undefined;
  }
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
  private readonly activeToolInputs = new Map<string, string>();
  private readonly activeToolExecutions = new Map<string, string>();

  private addActivity(
    activityType: TldrActivityType,
    displayPriority: TldrDisplayPriority,
    text: string,
    progressGroup?: string,
  ): TldrActivity {
    const activity = {
      index: this.nextIndex,
      activityType,
      displayPriority,
      text: truncateText(text, MAX_ACTIVITY_TEXT_CHARS),
      ...(progressGroup ? { progressGroup } : {}),
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
    this.activeToolInputs.clear();
    this.activeToolExecutions.clear();
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
   * @param event Optional streaming event with finer-grained update details.
   * @returns The recorded TLDR activity, or undefined for non-assistant/empty messages.
   */
  recordAssistantUpdate(
    message: AgentMessage,
    event?: AssistantMessageEvent,
  ): TldrActivity | undefined {
    if (!isAssistantMessage(message)) return undefined;

    const toolInput = toolInputActivity(event, this.activeToolInputs);
    if (toolInput) {
      if (toolInput.anchorKey && toolInput.anchorText) {
        this.activeToolInputs.set(toolInput.anchorKey, toolInput.anchorText);
      }
      if (toolInput.anchorKey && toolInput.clearAnchor) {
        this.activeToolInputs.delete(toolInput.anchorKey);
      }

      return this.addActivity(
        toolInput.activityType,
        "normal",
        toolInput.text,
        toolInput.progressGroup,
      );
    }

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
      appendPayload(`Tool started: ${event.toolName}`, event.input),
    );
  }

  /** Records the moment a tool starts executing. */
  recordToolExecutionStart(
    event: ToolExecutionStartActivityEvent,
  ): TldrActivity {
    const anchorText = appendPayload(
      `Tool running: ${event.toolName}`,
      event.args,
    );
    this.activeToolExecutions.set(event.toolCallId, anchorText);

    return this.addActivity("tool_execution_start", "normal", anchorText);
  }

  /** Records streaming progress from a running tool. */
  recordToolExecutionUpdate(
    event: ToolExecutionUpdateActivityEvent,
  ): TldrActivity {
    const anchorText =
      this.activeToolExecutions.get(event.toolCallId) ??
      appendPayload(`Tool running: ${event.toolName}`, event.args);

    return this.addActivity(
      "tool_execution_update",
      "normal",
      anchoredUpdateText(
        anchorText,
        appendPayload("Tool execution update", event.partialResult),
      ),
      `tool-execution:${event.toolCallId}`,
    );
  }

  /** Records the moment a tool finishes executing. */
  recordToolExecutionEnd(event: ToolExecutionEndActivityEvent): TldrActivity {
    const anchorText =
      this.activeToolExecutions.get(event.toolCallId) ??
      `Tool running: ${event.toolName}`;
    this.activeToolExecutions.delete(event.toolCallId);

    return this.addActivity(
      "tool_execution_end",
      "normal",
      anchoredUpdateText(
        anchorText,
        appendPayload(
          `Tool completed (${event.isError ? "error" : "ok"})`,
          event.result,
        ),
      ),
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

  /** Returns the latest retained activity, if any. */
  latestActivity(): TldrActivity | undefined {
    return this.activities.at(-1);
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
