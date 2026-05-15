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
