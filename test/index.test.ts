import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Api,
  AssistantMessage,
  Model,
  ProviderStreamOptions,
} from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createPiTldr, piTldr } from "../src/index.js";

function createFakeModel(
  provider = "anthropic",
  id = "claude-haiku-4-5",
): Model<Api> {
  return {
    provider,
    id,
    api: "openai-completions",
    name: id,
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  } as Model<Api>;
}

function createAssistantResponse(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AssistantMessage;
}

function waitForTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("piTldr extension entrypoint", () => {
  it("registers the flag, command, and lifecycle event handlers", () => {
    const flags: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const pi = {
      registerFlag(name: string) {
        flags.push(name);
      },
      registerCommand(name: string) {
        commands.push(name);
      },
      on(name: string) {
        events.push(name);
      },
    } as unknown as ExtensionAPI;

    piTldr(pi);

    assert.deepEqual(flags, ["tldr-model"]);
    assert.deepEqual(commands, ["tldr-model"]);
    assert.deepEqual(events, [
      "session_start",
      "session_shutdown",
      "before_agent_start",
      "message_update",
      "tool_call",
      "tool_result",
      "message_end",
    ]);
  });

  it("drives a prompt-start summary into the widget", async () => {
    const model = createFakeModel();
    const widgets: Array<unknown> = [];
    const eventHandlers = new Map<
      string,
      (event: any, ctx: ExtensionContext) => void
    >();
    const completeCalls: Array<{ options?: ProviderStreamOptions }> = [];
    const extension = createPiTldr({
      complete: async (_model, _context, options) => {
        completeCalls.push({ options });
        return createAssistantResponse("Inspecting repository status.");
      },
    });
    const pi = {
      registerFlag() {},
      registerCommand() {},
      on(name: string, handler: (event: any, ctx: ExtensionContext) => void) {
        eventHandlers.set(name, handler);
      },
      getFlag() {
        return undefined;
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      hasUI: true,
      ui: {
        setWidget(_key: string, widget: unknown) {
          widgets.push(widget);
        },
      },
      modelRegistry: {
        find(provider: string, id: string) {
          return provider === model.provider && id === model.id
            ? model
            : undefined;
        },
        async getApiKeyAndHeaders() {
          return { ok: true, apiKey: "test-key" };
        },
      },
    } as unknown as ExtensionContext;

    extension(pi);
    eventHandlers.get("session_start")?.({}, ctx);
    eventHandlers.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    await waitForTimers();

    assert.equal(completeCalls.length, 1);
    assert.equal(completeCalls[0]?.options?.cacheRetention, "none");
    assert.equal(completeCalls[0]?.options?.timeoutMs, 8_000);
    assert.equal(widgets.length, 3);
    assert.equal(widgets[0], undefined);
    assert.equal(widgets[1], undefined);
    assert.equal(typeof widgets[2], "function");
  });

  it("clears the widget and aborts stale work after an empty final stop", async () => {
    const model = createFakeModel();
    let abortSignal: AbortSignal | undefined;
    const widgets: Array<unknown> = [];
    const eventHandlers = new Map<
      string,
      (event: any, ctx: ExtensionContext) => void
    >();
    const extension = createPiTldr({
      complete: async (_model, _context, options) => {
        abortSignal = options?.signal;
        return new Promise(() => undefined);
      },
    });
    const pi = {
      registerFlag() {},
      registerCommand() {},
      on(name: string, handler: (event: any, ctx: ExtensionContext) => void) {
        eventHandlers.set(name, handler);
      },
      getFlag() {
        return undefined;
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      hasUI: true,
      ui: {
        setWidget(_key: string, widget: unknown) {
          widgets.push(widget);
        },
      },
      modelRegistry: {
        find(provider: string, id: string) {
          return provider === model.provider && id === model.id
            ? model
            : undefined;
        },
        async getApiKeyAndHeaders() {
          return { ok: true, apiKey: "test-key" };
        },
      },
    } as unknown as ExtensionContext;

    extension(pi);
    eventHandlers.get("session_start")?.({}, ctx);
    eventHandlers.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    await waitForTimers();

    assert.equal(abortSignal?.aborted, false);

    eventHandlers.get("message_end")?.(
      { message: createAssistantResponse("") },
      ctx,
    );

    assert.equal(abortSignal?.aborted, true);
    assert.equal(widgets.at(-1), undefined);
  });
});
