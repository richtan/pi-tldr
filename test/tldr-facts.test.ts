import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ToolCallEvent,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { TldrFactSession } from "../src/tldr-facts.js";

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

describe("TldrFactSession", () => {
  it("returns prompt and assistant update snapshots without secret filtering", () => {
    const facts = new TldrFactSession();

    facts.reset("Please use API_KEY=supersecretvalue to inspect status");
    assert.equal(
      facts.recordAssistantUpdate(
        assistantMessage("Checking token: abc123456789 before continuing"),
      ),
      true,
    );

    assert.equal(
      facts.snapshot(),
      "prompt=Please use API_KEY=supersecretvalue to inspect status\nevent=message_update\nassistantText=Checking token: abc123456789 before continuing",
    );
  });

  it("correlates tool results with stripped tool-call fields", () => {
    const facts = new TldrFactSession();
    facts.reset();

    facts.recordToolCall({
      toolName: "bash",
      toolCallId: "tool-1",
      input: { command: "curl --password hunter2 https://example.test" },
    } as unknown as ToolCallEvent);
    facts.recordToolResult({
      toolName: "bash",
      toolCallId: "tool-1",
      isError: false,
      content: [{ type: "text", text: "OPENAI_API_KEY=sk-1234567890abcdef" }],
    } as unknown as ToolResultEvent);

    assert.equal(
      facts.snapshot(),
      "event=tool_start\ntool=bash\ncommand=curl --password hunter2 https://example.test\nevent=tool_end\ntool=bash\ncommand=curl --password hunter2 https://example.test\nisError=false\nresult=OPENAI_API_KEY=sk-1234567890abcdef",
    );
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
});
