/**
 * @fileoverview Tests for indexed TLDR activity collection.
 *
 * These tests verify that prompts, assistant messages, tool calls, tool results,
 * and final stops are recorded as bounded model-visible activities without
 * redaction.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { extractTextContent, TldrFactCollector } from "../src/facts.js";

function assistantMessage(
  text: string,
  stopReason: "stop" | "toolUse" | "error" | "aborted" | "length" = "stop",
): AgentMessage {
  // Safe: the fixture includes the assistant fields used by TldrFactCollector.
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AgentMessage;
}

function assistantToolCallMessage(
  name: string,
  args: Record<string, unknown>,
): AssistantMessage {
  return {
    ...assistantMessage("", "toolUse"),
    content: [{ type: "toolCall", id: "tool-1", name, arguments: args }],
  } as AssistantMessage;
}

interface TestToolCallEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Record<string, unknown>;
}

interface TestToolResultEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly isError: boolean;
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
}

function toolCallEvent(event: TestToolCallEvent): ToolCallEvent {
  // Safe: these tests only exercise fields read by TldrFactCollector.
  return event as unknown as ToolCallEvent;
}

function toolResultEvent(event: TestToolResultEvent): ToolResultEvent {
  // Safe: these tests only exercise fields read by TldrFactCollector.
  return event as unknown as ToolResultEvent;
}

describe("text content extraction", () => {
  it("joins text blocks without cleaning them", () => {
    assert.equal(
      extractTextContent([
        { type: "text", text: " First " },
        { type: "image", data: "abc", mimeType: "image/png" },
        { type: "text", text: "\u001b[32mSecond\u001b[0m" },
      ]),
      " First \n\u001b[32mSecond\u001b[0m",
    );
    assert.equal(
      extractTextContent([
        { type: "image", data: "abc", mimeType: "image/png" },
      ]),
      undefined,
    );
  });
});

describe("TldrFactCollector", () => {
  it("ignores non-assistant messages", () => {
    const facts = new TldrFactCollector();
    // Safe: this negative test only needs the non-assistant role and content.
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
      timestamp: Date.now(),
    } as AgentMessage;

    assert.equal(facts.recordAssistantUpdate(userMessage), undefined);
    assert.equal(facts.recordMessageEnd(userMessage), "ignored");
    assert.deepEqual(facts.activitiesAfter(0, facts.latestActivityIndex()), []);
  });

  it("records generic streamed tool input activity", () => {
    const facts = new TldrFactCollector();
    const partial = assistantToolCallMessage("custom_tool", {
      query: "solana",
    });

    const start = facts.recordAssistantUpdate(partial, {
      type: "toolcall_start",
      contentIndex: 0,
      partial,
    });
    const update = facts.recordAssistantUpdate(partial, {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: ',"limit":10',
      partial,
    });
    const end = facts.recordAssistantUpdate(partial, {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: {
        type: "toolCall",
        id: "tool-1",
        name: "custom_tool",
        arguments: { query: "solana", limit: 10 },
      },
      partial,
    });

    assert.deepEqual(start, {
      index: 1,
      activityType: "tool_input_start",
      displayPriority: "normal",
      text: 'Tool input started: custom_tool\n{"query":"solana"}',
    });
    assert.deepEqual(update, {
      index: 2,
      activityType: "tool_input_update",
      displayPriority: "normal",
      progressGroup: "tool-input:tool-1",
      text: 'Main action: Tool input started: custom_tool\n{"query":"solana"}\nUpdate context: {"query":"solana"}\nLatest input chunk: ,"limit":10',
    });
    assert.deepEqual(end, {
      index: 3,
      activityType: "tool_input_end",
      displayPriority: "normal",
      text: 'Main action: Tool input started: custom_tool\n{"query":"solana"}\nUpdate context: Tool input completed\n{"query":"solana","limit":10}',
    });
  });

  it("records a user message as an immediate indexed activity", () => {
    const facts = new TldrFactCollector();

    const activity = facts.recordUserMessage("Please inspect the repository");

    assert.deepEqual(activity, {
      index: 1,
      activityType: "user_message",
      displayPriority: "immediate",
      text: "User message: Please inspect the repository",
    });
    assert.equal(facts.latestActivityIndex(), 1);
  });

  it("increments indexes across assistant, tool, and final activities", () => {
    const facts = new TldrFactCollector();

    const userMessage = facts.recordUserMessage("Check status");
    const assistantUpdate = facts.recordAssistantUpdate(
      assistantMessage("Checking recent changes before continuing"),
    );
    const toolCall = facts.recordToolCall(
      toolCallEvent({
        toolName: "bash",
        toolCallId: "tool-1",
        input: { command: "\u001b[31mnpm test\u001b[0m" },
      }),
    );
    const toolResult = facts.recordToolResult(
      toolResultEvent({
        toolName: "bash",
        toolCallId: "tool-1",
        isError: false,
        content: [{ type: "text", text: "\u001b[32mTests passed\u001b[0m" }],
      }),
    );
    const finalActivity = facts.recordMessageEnd(assistantMessage("Done."));

    assert.equal(userMessage.index, 1);
    assert.equal(assistantUpdate?.index, 2);
    assert.equal(toolCall.index, 3);
    assert.equal(toolResult.index, 4);
    assert.equal(toolResult.activityType, "tool_result");
    assert.equal(toolResult.displayPriority, "normal");
    if (typeof finalActivity !== "object") {
      assert.fail("expected final assistant activity");
    }
    assert.equal(finalActivity.index, 5);
    assert.equal(finalActivity.activityType, "assistant_final");
    assert.equal(finalActivity.displayPriority, "final");
    assert.equal(finalActivity.text, "Assistant final response: Done.");
  });

  it("does not reset indexes when another user message is recorded", () => {
    const facts = new TldrFactCollector();

    facts.recordUserMessage("First request");
    facts.recordToolCall(
      toolCallEvent({ toolName: "bash", toolCallId: "tool-1", input: {} }),
    );
    const followUp = facts.recordUserMessage("Continue with the same idea");

    assert.deepEqual(followUp, {
      index: 3,
      activityType: "user_message",
      displayPriority: "immediate",
      text: "User message: Continue with the same idea",
    });
  });

  it("records tool execution lifecycle activity", () => {
    const facts = new TldrFactCollector();

    const start = facts.recordToolExecutionStart({
      toolName: "bash",
      toolCallId: "tool-1",
      args: { command: "npm test" },
    });
    const update = facts.recordToolExecutionUpdate({
      toolName: "bash",
      toolCallId: "tool-1",
      args: { command: "npm test" },
      partialResult: {
        content: [{ type: "text", text: "Running test suite" }],
      },
    });
    const end = facts.recordToolExecutionEnd({
      toolName: "bash",
      toolCallId: "tool-1",
      isError: false,
      result: { content: [{ type: "text", text: "Tests passed" }] },
    });

    assert.deepEqual(start, {
      index: 1,
      activityType: "tool_execution_start",
      displayPriority: "normal",
      text: 'Tool running: bash\n{"command":"npm test"}',
    });
    assert.deepEqual(update, {
      index: 2,
      activityType: "tool_execution_update",
      displayPriority: "normal",
      progressGroup: "tool-execution:tool-1",
      text: 'Main action: Tool running: bash\n{"command":"npm test"}\nUpdate context: Tool execution update\nRunning test suite',
    });
    assert.deepEqual(end, {
      index: 3,
      activityType: "tool_execution_end",
      displayPriority: "normal",
      text: 'Main action: Tool running: bash\n{"command":"npm test"}\nUpdate context: Tool completed (ok)\nTests passed',
    });
  });

  it("middle-truncates long user messages without splitting surrogate pairs", () => {
    const facts = new TldrFactCollector();
    const prompt = `${"a".repeat(735)}🧪${"b".repeat(900)}TAIL✅`;

    const activity = facts.recordUserMessage(prompt);

    assert.equal(Array.from(activity.text).length, 1_500);
    assert.equal(
      activity.text.startsWith(`User message: ${"a".repeat(735)}🧪…`),
      true,
    );
    assert.equal(activity.text.endsWith("TAIL✅"), true);
  });

  it("middle-truncates long tool result text", () => {
    const facts = new TldrFactCollector();

    const activity = facts.recordToolResult(
      toolResultEvent({
        toolName: "bash",
        toolCallId: "tool-1",
        isError: false,
        content: [{ type: "text", text: `start-${"m".repeat(1_700)}-tail` }],
      }),
    );

    assert.equal(Array.from(activity.text).length, 1_500);
    assert.equal(
      activity.text.startsWith("Tool finished: bash (ok)\nstart-"),
      true,
    );
    assert.equal(activity.text.includes("…"), true);
    assert.equal(activity.text.endsWith("-tail"), true);
    assert.equal(activity.text.includes("m".repeat(1_700)), false);
  });

  it("returns activity deltas after a checkpoint index", () => {
    const facts = new TldrFactCollector();

    facts.recordUserMessage("One");
    const second = facts.recordToolCall(
      toolCallEvent({ toolName: "bash", toolCallId: "tool-1", input: {} }),
    );
    const third = facts.recordAssistantUpdate(assistantMessage("Working"));
    facts.recordUserMessage("Two");

    assert.deepEqual(facts.activitiesAfter(1, 3), [second, third]);
  });

  it("discards raw activity covered by accepted checkpoints", () => {
    const facts = new TldrFactCollector();

    facts.recordUserMessage("One");
    facts.recordToolCall(
      toolCallEvent({ toolName: "bash", toolCallId: "tool-1", input: {} }),
    );
    const retained = facts.recordUserMessage("Two");

    facts.discardActivitiesThrough(2);

    assert.deepEqual(facts.activitiesAfter(0, facts.latestActivityIndex()), [
      retained,
    ]);
  });

  it("returns emptyFinalStop without recording activity", () => {
    const facts = new TldrFactCollector();
    facts.recordUserMessage("TLDR this");
    facts.recordAssistantUpdate(assistantMessage("Working on it"));

    assert.equal(
      facts.recordMessageEnd(assistantMessage("")),
      "emptyFinalStop",
    );
    assert.equal(facts.latestActivityIndex(), 2);
  });

  it("ignores tool-use final messages", () => {
    const facts = new TldrFactCollector();
    facts.recordUserMessage("TLDR this");

    assert.equal(
      facts.recordMessageEnd(assistantMessage("", "toolUse")),
      "ignored",
    );
    assert.equal(facts.latestActivityIndex(), 1);
  });

  it("records non-stop final reasons as final failure activity", () => {
    const facts = new TldrFactCollector();
    // Safe: this fixture extends the assistant message with the error field
    // consumed for non-stop final reasons.
    const message = {
      ...assistantMessage("", "error"),
      errorMessage: "Provider failed",
    } as AgentMessage;

    const activity = facts.recordMessageEnd(message);

    if (typeof activity !== "object") {
      assert.fail("expected final failure activity");
    }
    assert.deepEqual(activity, {
      index: 1,
      activityType: "assistant_failure",
      displayPriority: "final",
      text: "Assistant finished with error: Provider failed",
    });
  });

  it("resets conversation state explicitly", () => {
    const facts = new TldrFactCollector();

    facts.recordUserMessage("One");
    facts.resetConversation();
    const activity = facts.recordUserMessage("Two");

    assert.equal(activity.index, 1);
    assert.deepEqual(facts.activitiesAfter(0, facts.latestActivityIndex()), [
      activity,
    ]);
  });
});
