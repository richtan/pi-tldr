/**
 * @fileoverview Tests for raw TLDR fact collection.
 *
 * These tests verify that prompts, assistant messages, tool calls, tool results,
 * and final stops are recorded without sanitizing, truncating, or validating text.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentMessage } from "@mariozechner/pi-agent-core";
import { ToolCallEvent, ToolResultEvent } from "@mariozechner/pi-coding-agent";
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

    assert.equal(facts.recordAssistantUpdate(userMessage), false);
    assert.equal(facts.recordMessageEnd(userMessage), "ignored");
    assert.equal(facts.snapshot(), "");
  });

  it("returns prompt and assistant update snapshots", () => {
    const facts = new TldrFactCollector();

    facts.reset("Please inspect the repository status");
    assert.equal(
      facts.recordAssistantUpdate(
        assistantMessage("Checking recent changes before continuing"),
      ),
      true,
    );

    assert.equal(
      facts.snapshot(),
      "Prompt: Please inspect the repository status\nAssistant update: Checking recent changes before continuing",
    );
  });

  it("records raw tool starts and results", () => {
    const facts = new TldrFactCollector();
    facts.reset();

    facts.recordToolCall(
      toolCallEvent({
        toolName: "bash",
        toolCallId: "tool-1",
        input: { command: "\u001b[31mnpm test\u001b[0m" },
      }),
    );
    facts.recordToolResult(
      toolResultEvent({
        toolName: "bash",
        toolCallId: "tool-1",
        isError: false,
        content: [{ type: "text", text: "\u001b[32mTests passed\u001b[0m" }],
      }),
    );

    assert.equal(
      facts.snapshot(),
      "Tool started: bash\nTool finished: bash (ok)\n\u001b[32mTests passed\u001b[0m",
    );
  });

  it("records every assistant update without dedupe or truncation", () => {
    const facts = new TldrFactCollector();
    facts.reset("a".repeat(230));

    facts.recordAssistantUpdate(assistantMessage("Step 1"));
    facts.recordAssistantUpdate(assistantMessage("Step 1"));

    assert.equal(
      facts.snapshot(),
      `${`Prompt: ${"a".repeat(230)}`}\nAssistant update: Step 1\nAssistant update: Step 1`,
    );
  });

  it("returns emptyFinalStop and clears stale facts", () => {
    const facts = new TldrFactCollector();
    facts.reset("TLDR this");
    facts.recordAssistantUpdate(assistantMessage("Working on it"));

    assert.equal(
      facts.recordMessageEnd(assistantMessage("")),
      "emptyFinalStop",
    );
    assert.equal(facts.snapshot(), "");
  });

  it("ignores tool-use final messages", () => {
    const facts = new TldrFactCollector();
    facts.reset("TLDR this");

    assert.equal(
      facts.recordMessageEnd(assistantMessage("", "toolUse")),
      "ignored",
    );
    assert.equal(facts.snapshot(), "Prompt: TLDR this");
  });

  it("records final stop text as the only activity fact", () => {
    const facts = new TldrFactCollector();
    facts.reset("TLDR this");
    facts.recordAssistantUpdate(assistantMessage("Working on it"));

    assert.equal(facts.recordMessageEnd(assistantMessage("Done.")), "recorded");
    assert.equal(
      facts.snapshot(),
      "Prompt: TLDR this\nAssistant final response: Done.",
    );
  });

  it("records non-stop final reasons with error context", () => {
    const facts = new TldrFactCollector();
    // Safe: this fixture extends the assistant message with the error field
    // consumed for non-stop final reasons.
    const message = {
      ...assistantMessage("", "error"),
      errorMessage: "Provider failed",
    } as AgentMessage;

    assert.equal(facts.recordMessageEnd(message), "recorded");
    assert.equal(
      facts.snapshot(),
      "Assistant finished with error: Provider failed",
    );
  });
});
