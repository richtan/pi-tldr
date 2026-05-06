import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  type AssistantMessage,
  type ImageContent,
  type TextContent,
} from "@mariozechner/pi-ai";
import {
  isToolCallEventType,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import {
  type FactField,
  formatFact,
  stripAnsi,
  truncateText,
} from "./tldr-core.js";

const MAX_FACT_CHARS = 1_800;
const MAX_PROMPT_CHARS = 220;
const MAX_ACTIVITY_HISTORY = 5;
const FINAL_RESULT_CONTEXT_CHARS = 1_200;

type TextSourceContent =
  | AssistantMessage["content"][number]
  | TextContent
  | ImageContent;

export type MessageEndRecordResult = "recorded" | "emptyFinalStop" | "ignored";

export function isAssistantMessage(
  message: AgentMessage,
): message is AssistantMessage {
  return "role" in message && message.role === "assistant";
}

function isTextContent(content: TextSourceContent): content is TextContent {
  return content.type === "text";
}

export function extractTextContent(
  content: readonly TextSourceContent[],
): string | undefined {
  const text = content
    .filter(isTextContent)
    .map(({ text }) => text)
    .join("\n")
    .trim();
  return text || undefined;
}

function sanitizeFactFields(
  fields: readonly FactField[],
): readonly FactField[] {
  return fields.map(({ name, value, maxChars }) => ({
    name,
    value: value === undefined ? undefined : stripAnsi(String(value)),
    maxChars,
  }));
}

function toolCallFactFields(event: ToolCallEvent): readonly FactField[] {
  if (isToolCallEventType("bash", event)) {
    return [
      { name: "tool", value: "bash" },
      { name: "command", value: event.input.command, maxChars: 240 },
    ];
  }
  if (isToolCallEventType("read", event)) {
    const { path, offset, limit } = event.input;
    return [
      { name: "tool", value: "read" },
      { name: "path", value: path, maxChars: 240 },
      { name: "offset", value: offset },
      { name: "limit", value: limit },
    ];
  }
  if (isToolCallEventType("grep", event)) {
    const { pattern, path, glob } = event.input;
    return [
      { name: "tool", value: "grep" },
      { name: "pattern", value: pattern, maxChars: 160 },
      { name: "path", value: path, maxChars: 240 },
      { name: "glob", value: glob },
    ];
  }
  if (isToolCallEventType("find", event)) {
    const { pattern, path } = event.input;
    return [
      { name: "tool", value: "find" },
      { name: "pattern", value: pattern, maxChars: 160 },
      { name: "path", value: path, maxChars: 240 },
    ];
  }
  if (isToolCallEventType("ls", event)) {
    return [
      { name: "tool", value: "ls" },
      { name: "path", value: event.input.path, maxChars: 240 },
    ];
  }
  if (isToolCallEventType("edit", event)) {
    return [
      { name: "tool", value: "edit" },
      { name: "path", value: event.input.path, maxChars: 240 },
      { name: "editCount", value: event.input.edits.length },
    ];
  }
  if (isToolCallEventType("write", event)) {
    return [
      { name: "tool", value: "write" },
      { name: "path", value: event.input.path, maxChars: 240 },
    ];
  }
  return [{ name: "tool", value: event.toolName }];
}

function toolResultFact(
  event: ToolResultEvent,
  toolStartFields: readonly FactField[] = [
    { name: "tool", value: event.toolName },
  ],
): string {
  const resultText = extractTextContent(event.content);
  return formatFact("tool_end", [
    ...toolStartFields,
    { name: "isError", value: event.isError },
    { name: "result", value: resultText, maxChars: MAX_FACT_CHARS },
  ]);
}

function finalFact(message: AssistantMessage): string | undefined {
  switch (message.stopReason) {
    case "toolUse":
      return undefined;
    case "error":
    case "aborted":
    case "length":
      return formatFact("message_end", [
        { name: "stopReason", value: message.stopReason },
        { name: "errorMessage", value: message.errorMessage },
      ]);
    case "stop": {
      const finalText = extractTextContent(message.content);
      if (!finalText) return undefined;

      return formatFact("message_end", [
        { name: "stopReason", value: "stop" },
        {
          name: "finalResultContext",
          value: finalText,
          maxChars: FINAL_RESULT_CONTEXT_CHARS,
        },
      ]);
    }
    default:
      return undefined;
  }
}

/**
 * Collects model-visible TLDR facts for one active agent run.
 *
 * The class owns activity budgets, adjacent dedupe, ANSI stripping, and tool
 * start/result correlation so callers only record domain events and request a
 * normalized snapshot.
 */
export class TldrFactSession {
  private prompt = "";
  private readonly activity: string[] = [];
  private readonly toolFactFieldsById = new Map<string, readonly FactField[]>();

  public reset(prompt?: string): void {
    this.prompt = truncateText(stripAnsi(prompt ?? ""), MAX_PROMPT_CHARS);
    this.activity.splice(0);
    this.toolFactFieldsById.clear();
  }

  public recordAssistantUpdate(message: AgentMessage): boolean {
    if (!isAssistantMessage(message)) return false;

    const assistantText = extractTextContent(message.content);
    if (!assistantText) return false;

    this.addFact(
      formatFact("message_update", [
        {
          name: "assistantText",
          value: assistantText,
          maxChars: MAX_FACT_CHARS,
        },
      ]),
    );
    return true;
  }

  public recordToolCall(event: ToolCallEvent): void {
    const fields = sanitizeFactFields(toolCallFactFields(event));
    this.toolFactFieldsById.set(event.toolCallId, fields);
    this.addFact(formatFact("tool_start", fields));
  }

  public recordToolResult(event: ToolResultEvent): void {
    const toolStartFields = this.toolFactFieldsById.get(event.toolCallId);
    this.toolFactFieldsById.delete(event.toolCallId);
    this.addFact(toolResultFact(event, toolStartFields));
  }

  public recordMessageEnd(message: AgentMessage): MessageEndRecordResult {
    if (!isAssistantMessage(message)) return "ignored";

    const fact = finalFact(message);
    if (!fact) {
      if (message.stopReason !== "stop") return "ignored";
      this.reset();
      return "emptyFinalStop";
    }

    this.activity.splice(0);
    this.addFact(fact);
    return "recorded";
  }

  public snapshot(): string {
    const promptLine = this.prompt ? `prompt=${this.prompt}` : undefined;
    const activityBudget =
      MAX_FACT_CHARS - (promptLine ? promptLine.length + 1 : 0);
    const recentActivity: string[] = [];
    let remaining = Math.max(0, activityBudget);

    for (
      let index = this.activity.length - 1;
      index >= 0 && remaining > 0;
      index--
    ) {
      const fact = this.activity[index];
      if (!fact) continue;

      const separatorLength = recentActivity.length === 0 ? 0 : 1;
      const needed = fact.length + separatorLength;
      if (needed <= remaining) {
        recentActivity.unshift(fact);
        remaining -= needed;
        continue;
      }

      if (recentActivity.length === 0) {
        recentActivity.unshift(truncateText(fact, remaining));
      }
      break;
    }

    return [promptLine, recentActivity.join("\n") || undefined]
      .filter((item): item is string => item !== undefined)
      .join("\n");
  }

  private addFact(fact: string): void {
    if (!fact || this.activity[this.activity.length - 1] === fact) return;

    this.activity.push(fact);
    if (this.activity.length > MAX_ACTIVITY_HISTORY) {
      this.activity.splice(0, this.activity.length - MAX_ACTIVITY_HISTORY);
    }
  }
}
