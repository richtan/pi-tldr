import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ToolCallEvent,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { extractTextContent, TldrFactSession } from "../src/tldr-facts.js";

function assistantMessage(
  text: string,
  stopReason: "stop" | "toolUse" | "error" | "aborted" | "length" = "stop",
): AgentMessage {
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

describe("text content extraction", () => {
  it("joins text blocks and ignores non-text content", () => {
    assert.equal(
      extractTextContent([
        { type: "text", text: " First " },
        { type: "image", data: "abc", mimeType: "image/png" },
        { type: "text", text: "Second" },
      ]),
      "First \nSecond",
    );
    assert.equal(
      extractTextContent([
        { type: "image", data: "abc", mimeType: "image/png" },
      ]),
      undefined,
    );
  });
});

describe("TldrFactSession", () => {
  it("ignores non-assistant messages", () => {
    const facts = new TldrFactSession();
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
    const facts = new TldrFactSession();

    facts.reset("Please inspect the repository status");
    assert.equal(
      facts.recordAssistantUpdate(
        assistantMessage("Checking recent changes before continuing"),
      ),
      true,
    );

    assert.equal(
      facts.snapshot(),
      "prompt=Please inspect the repository status\nevent=message_update\nassistantText=Checking recent changes before continuing",
    );
  });

  it("correlates tool results with stripped tool-call fields", () => {
    const facts = new TldrFactSession();
    facts.reset();

    facts.recordToolCall({
      toolName: "bash",
      toolCallId: "tool-1",
      input: { command: "npm test" },
    } as unknown as ToolCallEvent);
    facts.recordToolResult({
      toolName: "bash",
      toolCallId: "tool-1",
      isError: false,
      content: [{ type: "text", text: "Tests passed" }],
    } as unknown as ToolResultEvent);

    assert.equal(
      facts.snapshot(),
      "event=tool_start\ntool=bash\ncommand=npm test\nevent=tool_end\ntool=bash\ncommand=npm test\nisError=false\nresult=Tests passed",
    );
  });

  it("falls back to result tool name when a tool result has no start event", () => {
    const facts = new TldrFactSession();
    facts.reset();

    facts.recordToolResult({
      toolName: "custom_tool",
      toolCallId: "missing-start",
      isError: true,
      content: [{ type: "text", text: "Failed" }],
    } as unknown as ToolResultEvent);

    assert.equal(
      facts.snapshot(),
      "event=tool_end\ntool=custom_tool\nisError=true\nresult=Failed",
    );
  });

  it("records read and edit tool fields", () => {
    const facts = new TldrFactSession();
    facts.reset();

    facts.recordToolCall({
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "src/index.ts", offset: 5, limit: 20 },
    } as unknown as ToolCallEvent);
    facts.recordToolCall({
      toolName: "edit",
      toolCallId: "edit-1",
      input: { path: "README.md", edits: [{ oldText: "a", newText: "b" }] },
    } as unknown as ToolCallEvent);

    assert.equal(
      facts.snapshot(),
      "event=tool_start\ntool=read\npath=src/index.ts\noffset=5\nlimit=20\nevent=tool_start\ntool=edit\npath=README.md\neditCount=1",
    );
  });

  it("records search, list, and write tool fields", () => {
    const facts = new TldrFactSession();
    facts.reset();

    facts.recordToolCall({
      toolName: "grep",
      toolCallId: "grep-1",
      input: { pattern: "TODO", path: "src", glob: "*.ts" },
    } as unknown as ToolCallEvent);
    facts.recordToolCall({
      toolName: "find",
      toolCallId: "find-1",
      input: { pattern: "*.test.ts", path: "test" },
    } as unknown as ToolCallEvent);
    facts.recordToolCall({
      toolName: "ls",
      toolCallId: "ls-1",
      input: { path: "src" },
    } as unknown as ToolCallEvent);
    facts.recordToolCall({
      toolName: "write",
      toolCallId: "write-1",
      input: { path: "notes.txt" },
    } as unknown as ToolCallEvent);

    assert.equal(
      facts.snapshot(),
      [
        "event=tool_start\ntool=grep\npattern=TODO\npath=src\nglob=*.ts",
        "event=tool_start\ntool=find\npattern=*.test.ts\npath=test",
        "event=tool_start\ntool=ls\npath=src",
        "event=tool_start\ntool=write\npath=notes.txt",
      ].join("\n"),
    );
  });

  it("deduplicates adjacent activity and keeps the five most recent facts", () => {
    const facts = new TldrFactSession();
    facts.reset();

    facts.recordAssistantUpdate(assistantMessage("Step 1"));
    facts.recordAssistantUpdate(assistantMessage("Step 1"));
    for (let index = 2; index <= 6; index++) {
      facts.recordAssistantUpdate(assistantMessage(`Step ${index}`));
    }

    const snapshot = facts.snapshot();
    assert.equal(snapshot.includes("Step 1"), false);
    assert.equal(snapshot.includes("Step 2"), true);
    assert.equal(snapshot.includes("Step 6"), true);
  });

  it("truncates long prompts before snapshotting", () => {
    const facts = new TldrFactSession();
    facts.reset("a".repeat(230));

    assert.equal(facts.snapshot(), `prompt=${"a".repeat(219)}…`);
  });

  it("returns emptyFinalStop and clears stale facts", () => {
    const facts = new TldrFactSession();
    facts.reset("Summarize this");
    facts.recordAssistantUpdate(assistantMessage("Working on it"));

    assert.equal(
      facts.recordMessageEnd(assistantMessage("")),
      "emptyFinalStop",
    );
    assert.equal(facts.snapshot(), "");
  });

  it("ignores tool-use final messages", () => {
    const facts = new TldrFactSession();
    facts.reset("Summarize this");

    assert.equal(
      facts.recordMessageEnd(assistantMessage("", "toolUse")),
      "ignored",
    );
    assert.equal(facts.snapshot(), "prompt=Summarize this");
  });

  it("records final stop text as the only activity fact", () => {
    const facts = new TldrFactSession();
    facts.reset("Summarize this");
    facts.recordAssistantUpdate(assistantMessage("Working on it"));

    assert.equal(facts.recordMessageEnd(assistantMessage("Done.")), "recorded");
    assert.equal(
      facts.snapshot(),
      "prompt=Summarize this\nevent=message_end\nstopReason=stop\nfinalResultContext=Done.",
    );
  });

  it("records non-stop final reasons with error context", () => {
    const facts = new TldrFactSession();
    const message = {
      ...assistantMessage("", "error"),
      errorMessage: "Provider failed",
    } as AgentMessage;

    assert.equal(facts.recordMessageEnd(message), "recorded");
    assert.equal(
      facts.snapshot(),
      "event=message_end\nstopReason=error\nerrorMessage=Provider failed",
    );
  });
});
