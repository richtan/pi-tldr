/**
 * @fileoverview Raw fact collection for model-visible TLDR context.
 *
 * This module keeps only the small amount of structure needed to turn pi events
 * into readable context for the TLDR model. It intentionally avoids sanitizing,
 * truncating, normalizing, scoring, or validating text.
 */
import { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  AssistantMessage,
  ImageContent,
  TextContent,
} from "@mariozechner/pi-ai";
import { ToolCallEvent, ToolResultEvent } from "@mariozechner/pi-coding-agent";

type TextSourceContent =
  | AssistantMessage["content"][number]
  | TextContent
  | ImageContent;

/** Result of recording an assistant message-end event into TLDR facts. */
export type MessageEndRecordResult = "recorded" | "emptyFinalStop" | "ignored";

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
function finalFact(message: AssistantMessage): string | undefined {
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

/** Narrows optional snapshot lines to lines that should be joined. */
function isSnapshotLine(line: string | undefined): line is string {
  return line !== undefined;
}

/**
 * Collects model-visible TLDR facts for one active agent run.
 *
 * Callers record pi events and request the current raw snapshot. The collector
 * does not clean, truncate, dedupe, or reformat event text beyond brief labels
 * that identify where each piece of context came from.
 */
export class TldrFactCollector {
  private prompt = "";
  private readonly activity: string[] = [];

  /**
   * Starts a fresh fact collection for a new agent run.
   *
   * @param prompt Optional user prompt to include as context.
   */
  reset(prompt?: string): void {
    this.prompt = prompt ?? "";
    this.activity.splice(0);
  }

  /**
   * Records assistant streaming/update text as in-progress activity.
   *
   * @param message Pi message update event payload.
   * @returns Whether the message produced a TLDR fact.
   */
  recordAssistantUpdate(message: AgentMessage): boolean {
    if (!isAssistantMessage(message)) return false;

    const assistantText = extractTextContent(message.content);
    if (!assistantText) return false;

    this.activity.push(`Assistant update: ${assistantText}`);
    return true;
  }

  /** Records a tool call as generic tool activity. */
  recordToolCall(event: ToolCallEvent): void {
    this.activity.push(`Tool started: ${event.toolName}`);
  }

  /** Records a tool result as generic result activity. */
  recordToolResult(event: ToolResultEvent): void {
    const resultText = extractTextContent(event.content);
    this.activity.push(
      resultText
        ? `Tool finished: ${event.toolName} (${event.isError ? "error" : "ok"})\n${resultText}`
        : `Tool finished: ${event.toolName} (${event.isError ? "error" : "ok"})`,
    );
  }

  /**
   * Records or clears final assistant activity.
   *
   * @param message Final pi agent message.
   * @returns How the message affected TLDR facts.
   */
  recordMessageEnd(message: AgentMessage): MessageEndRecordResult {
    if (!isAssistantMessage(message)) return "ignored";

    const fact = finalFact(message);
    if (!fact) {
      if (message.stopReason !== "stop") return "ignored";
      this.reset();
      return "emptyFinalStop";
    }

    this.activity.splice(0);
    this.activity.push(fact);
    return "recorded";
  }

  /**
   * Returns the current model-visible fact snapshot.
   *
   * @returns Prompt plus recorded activity, or an empty string when no facts exist.
   */
  snapshot(): string {
    return [
      this.prompt ? `Prompt: ${this.prompt}` : undefined,
      ...this.activity,
    ]
      .filter(isSnapshotLine)
      .join("\n");
  }
}
