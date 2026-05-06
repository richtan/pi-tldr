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
import type { PreferredModelStore } from "../src/tldr-models.js";

type EventHandler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => void;
type CommandHandler = (
  args: string,
  ctx: ExtensionContext,
) => Promise<void> | void;

interface RegisteredCommand {
  readonly handler: CommandHandler;
}

interface FakePiHarness {
  readonly pi: ExtensionAPI;
  readonly commands: Map<string, RegisteredCommand>;
  readonly events: Map<string, EventHandler>;
}

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

function createMemoryPreferredModelStore(): PreferredModelStore {
  let savedModel: string | undefined;
  return {
    load() {
      return savedModel;
    },
    save(modelSpec) {
      savedModel = modelSpec;
      return undefined;
    },
    clear() {
      savedModel = undefined;
      return undefined;
    },
  };
}

function createFakePiHarness(): FakePiHarness {
  const commands = new Map<string, RegisteredCommand>();
  const events = new Map<string, EventHandler>();
  const pi = {
    registerFlag() {},
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    on(name: string, handler: EventHandler) {
      events.set(name, handler);
    },
    getFlag() {
      return undefined;
    },
  } as unknown as ExtensionAPI;

  return { pi, commands, events };
}

type FakeAuthResult = { readonly ok: boolean; readonly apiKey?: string };
type FakeAuthProvider = (
  model: Model<Api>,
) => Promise<FakeAuthResult> | FakeAuthResult;

function createFakeContext(options: {
  readonly model?: Model<Api>;
  readonly models?: readonly Model<Api>[];
  readonly auth?: FakeAuthResult | FakeAuthProvider;
  readonly widgets?: unknown[];
  readonly notifications?: Array<{
    readonly message: string;
    readonly level: string;
  }>;
}): ExtensionContext {
  const models = options.models ?? [options.model ?? createFakeModel()];
  return {
    hasUI: true,
    ui: {
      setWidget(_key: string, widget: unknown) {
        options.widgets?.push(widget);
      },
      notify(message: string, level: string) {
        options.notifications?.push({ message, level });
      },
    },
    modelRegistry: {
      find(provider: string, id: string) {
        return models.find(
          (model) => provider === model.provider && id === model.id,
        );
      },
      async getApiKeyAndHeaders(model: Model<Api>) {
        if (typeof options.auth === "function") return options.auth(model);
        return options.auth ?? { ok: true, apiKey: "test-key" };
      },
    },
  } as unknown as ExtensionContext;
}

function waitForTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("piTldr extension entrypoint", () => {
  it("registers the flags, commands, and lifecycle event handlers", () => {
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
    assert.deepEqual(commands, ["tldr"]);
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

  it("toggles pi-tldr off for the current session", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    const ctx = createFakeContext({ notifications });

    createPiTldr({ preferredModelStore: createMemoryPreferredModelStore() })(
      pi,
    );
    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("off", ctx);
    await commands.get("tldr")?.handler("status", ctx);

    assert.equal(
      notifications.at(-1)?.message,
      [
        "pi-tldr status",
        "enabled: no",
        "selected model: auto",
        "active model: none",
      ].join("\n"),
    );
  });

  it("shows available commands for bare /tldr", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    const ctx = createFakeContext({ notifications });

    createPiTldr({ preferredModelStore: createMemoryPreferredModelStore() })(
      pi,
    );
    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("", ctx);

    assert.deepEqual(notifications, [
      {
        level: "info",
        message: [
          "pi-tldr commands",
          "/tldr help - show this help",
          "/tldr status - show enabled and model status",
          "/tldr stats - show session latency stats",
          "/tldr on - enable TLDRs for this session",
          "/tldr off - disable TLDRs for this session",
          "/tldr toggle - toggle TLDRs for this session",
          "/tldr model - choose the TLDR model",
          "/tldr model <model|auto|reset> - set the TLDR model",
        ].join("\n"),
      },
    ]);
  });

  it("reports enabled status, selected model, and active auto model", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    const ctx = createFakeContext({ notifications });

    createPiTldr({ preferredModelStore: createMemoryPreferredModelStore() })(
      pi,
    );
    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("status", ctx);

    assert.deepEqual(notifications, [
      {
        level: "info",
        message: [
          "pi-tldr status",
          "enabled: yes",
          "selected model: auto",
          "active model: anthropic/claude-haiku-4-5",
        ].join("\n"),
      },
    ]);
  });

  it("reports when auto has no active model", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    const ctx = createFakeContext({
      auth: { ok: false },
      notifications,
    });

    createPiTldr({ preferredModelStore: createMemoryPreferredModelStore() })(
      pi,
    );
    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("status", ctx);

    assert.equal(
      notifications.at(-1)?.message,
      [
        "pi-tldr status",
        "enabled: yes",
        "selected model: auto",
        "active model: none",
      ].join("\n"),
    );
  });

  it("reports directly selected models as selected and active", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    const ctx = createFakeContext({
      model: createFakeModel("openai-codex", "gpt-5.4-mini"),
      notifications,
    });

    createPiTldr({ preferredModelStore: createMemoryPreferredModelStore() })(
      pi,
    );
    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("model openai-codex/gpt-5.4-mini", ctx);
    await commands.get("tldr")?.handler("status", ctx);

    assert.equal(
      notifications.at(-1)?.message,
      [
        "pi-tldr status",
        "enabled: yes",
        "selected model: openai-codex/gpt-5.4-mini",
        "active model: openai-codex/gpt-5.4-mini",
      ].join("\n"),
    );
  });

  it("reports active fallback when a selected model is unavailable", async () => {
    const selectedModel = createFakeModel("openai-codex", "gpt-5.4-mini");
    const fallbackModel = createFakeModel("anthropic", "claude-haiku-4-5");
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    const ctx = createFakeContext({
      models: [selectedModel, fallbackModel],
      auth: (model) =>
        model.provider === selectedModel.provider
          ? { ok: false }
          : { ok: true, apiKey: "test-key" },
      notifications,
    });

    createPiTldr({ preferredModelStore: createMemoryPreferredModelStore() })(
      pi,
    );
    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("model openai-codex/gpt-5.4-mini", ctx);
    await commands.get("tldr")?.handler("status", ctx);

    assert.equal(
      notifications.at(-1)?.message,
      [
        "pi-tldr status",
        "enabled: yes",
        "selected model: openai-codex/gpt-5.4-mini",
        "active model: anthropic/claude-haiku-4-5",
      ].join("\n"),
    );
  });

  it("reports active model auth check failures", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    const ctx = createFakeContext({
      auth: () => {
        throw new Error("auth failed");
      },
      notifications,
    });

    createPiTldr({ preferredModelStore: createMemoryPreferredModelStore() })(
      pi,
    );
    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("status", ctx);

    assert.equal(
      notifications.at(-1)?.message,
      [
        "pi-tldr status",
        "enabled: yes",
        "selected model: auto",
        "active model: unknown (auth check failed)",
      ].join("\n"),
    );
  });

  it("asks users to retry when status keeps changing during model checks", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    let ctx: ExtensionContext;
    ctx = createFakeContext({
      auth: () => {
        events.get("session_start")?.({}, ctx);
        return { ok: true, apiKey: "test-key" };
      },
      notifications,
    });

    createPiTldr({ preferredModelStore: createMemoryPreferredModelStore() })(
      pi,
    );
    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("status", ctx);

    assert.equal(
      notifications.at(-1)?.message,
      ["pi-tldr status", "status changed while checking; run /tldr again"].join(
        "\n",
      ),
    );
  });

  it("reports no latency stats before a TLDR widget update", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    const ctx = createFakeContext({ notifications });

    createPiTldr({ preferredModelStore: createMemoryPreferredModelStore() })(
      pi,
    );
    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("stats", ctx);

    assert.deepEqual(notifications, [
      {
        level: "info",
        message: ["pi-tldr stats", "avg latency: n/a", "samples: 0"].join("\n"),
      },
    ]);
  });

  it("reports average latency from trigger to accepted widget update", async () => {
    let now = 1_000;
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    const responses = [
      "Inspecting repository status.",
      "Updated the project scripts.",
    ];
    const extension = createPiTldr({
      preferredModelStore: createMemoryPreferredModelStore(),
      latencyNow: () => now,
      complete: async () => {
        const response = responses.shift();
        now += response?.startsWith("Inspecting") ? 250 : 450;
        return createAssistantResponse(response ?? "Finished the task.");
      },
    });
    const ctx = createFakeContext({ notifications });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    await waitForTimers();

    now = 2_000;
    events.get("before_agent_start")?.({ prompt: "Update scripts" }, ctx);
    await waitForTimers();

    await commands.get("tldr")?.handler("stats", ctx);

    assert.equal(
      notifications.at(-1)?.message,
      ["pi-tldr stats", "avg latency: 350ms", "samples: 2"].join("\n"),
    );
  });

  it("resets latency stats on session start", async () => {
    let now = 1_000;
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    const extension = createPiTldr({
      preferredModelStore: createMemoryPreferredModelStore(),
      latencyNow: () => now,
      complete: async () => {
        now += 125;
        return createAssistantResponse("Inspecting repository status.");
      },
    });
    const ctx = createFakeContext({ notifications });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    await waitForTimers();
    await commands.get("tldr")?.handler("stats", ctx);

    assert.equal(
      notifications.at(-1)?.message,
      ["pi-tldr stats", "avg latency: 125ms", "samples: 1"].join("\n"),
    );

    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("stats", ctx);

    assert.equal(
      notifications.at(-1)?.message,
      ["pi-tldr stats", "avg latency: n/a", "samples: 0"].join("\n"),
    );
  });

  it("drives a prompt-start summary into the widget", async () => {
    const widgets: Array<unknown> = [];
    const { pi, events } = createFakePiHarness();
    const completeCalls: Array<{ options?: ProviderStreamOptions }> = [];
    const extension = createPiTldr({
      preferredModelStore: createMemoryPreferredModelStore(),
      complete: async (_model, _context, options) => {
        completeCalls.push({ options });
        return createAssistantResponse("Inspecting repository status.");
      },
    });
    const ctx = createFakeContext({ widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    await waitForTimers();

    assert.equal(completeCalls.length, 1);
    assert.equal(completeCalls[0]?.options?.cacheRetention, "none");
    assert.equal(completeCalls[0]?.options?.timeoutMs, 8_000);
    assert.equal(widgets.length, 3);
    assert.equal(widgets[0], undefined);
    assert.equal(widgets[1], undefined);
    assert.equal(typeof widgets[2], "function");
  });

  it("aborts in-flight TLDR work when disabled", async () => {
    let abortSignal: AbortSignal | undefined;
    const widgets: Array<unknown> = [];
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    const extension = createPiTldr({
      preferredModelStore: createMemoryPreferredModelStore(),
      complete: async (_model, _context, options) => {
        abortSignal = options?.signal;
        return new Promise(() => undefined);
      },
    });
    const ctx = createFakeContext({ notifications, widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    await waitForTimers();

    assert.equal(abortSignal?.aborted, false);

    await commands.get("tldr")?.handler("off", ctx);

    assert.equal(abortSignal?.aborted, true);
    assert.equal(widgets.at(-1), undefined);
    assert.equal(
      notifications.at(-1)?.message,
      "pi-tldr disabled for this session",
    );
  });

  it("does not send facts recorded while disabled after reenable", async () => {
    let completionPayload = "";
    const { pi, commands, events } = createFakePiHarness();
    const extension = createPiTldr({
      preferredModelStore: createMemoryPreferredModelStore(),
      complete: async (_model, context) => {
        completionPayload = JSON.stringify(context);
        return createAssistantResponse("Inspecting safe follow-up work.");
      },
    });
    const ctx = createFakeContext({});

    extension(pi);
    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("off", ctx);
    events.get("before_agent_start")?.(
      { prompt: "Sensitive disabled prompt" },
      ctx,
    );
    events.get("message_update")?.(
      { message: createAssistantResponse("Sensitive disabled update") },
      ctx,
    );
    await commands.get("tldr")?.handler("on", ctx);
    events.get("message_update")?.(
      { message: createAssistantResponse("Safe enabled update") },
      ctx,
    );
    await waitForTimers();

    assert.equal(completionPayload.includes("Safe enabled update"), true);
    assert.equal(completionPayload.includes("Sensitive disabled"), false);
  });

  it("resets disabled state on the next session start", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    const ctx = createFakeContext({ notifications });

    createPiTldr({ preferredModelStore: createMemoryPreferredModelStore() })(
      pi,
    );
    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("off", ctx);
    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("status", ctx);

    assert.equal(
      notifications.at(-1)?.message,
      [
        "pi-tldr status",
        "enabled: yes",
        "selected model: auto",
        "active model: anthropic/claude-haiku-4-5",
      ].join("\n"),
    );
  });

  it("supports /tldr toggle, status, and invalid actions", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    const ctx = createFakeContext({ notifications });

    createPiTldr({ preferredModelStore: createMemoryPreferredModelStore() })(
      pi,
    );
    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("toggle", ctx);
    await commands.get("tldr")?.handler("status", ctx);
    await commands.get("tldr")?.handler("later", ctx);

    assert.equal(
      notifications.at(-3)?.message,
      "pi-tldr disabled for this session",
    );
    assert.equal(
      notifications.at(-2)?.message,
      [
        "pi-tldr status",
        "enabled: no",
        "selected model: auto",
        "active model: none",
      ].join("\n"),
    );
    assert.deepEqual(notifications.at(-1), {
      message: "Use /tldr [help|status|stats|on|off|toggle|model <model>]",
      level: "error",
    });
  });

  it("reenables pi-tldr locally after it has been disabled", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { pi, commands, events } = createFakePiHarness();
    const ctx = createFakeContext({ notifications });

    createPiTldr({ preferredModelStore: createMemoryPreferredModelStore() })(
      pi,
    );
    events.get("session_start")?.({}, ctx);
    await commands.get("tldr")?.handler("off", ctx);
    await commands.get("tldr")?.handler("on", ctx);
    await commands.get("tldr")?.handler("status", ctx);

    assert.equal(
      notifications.at(-1)?.message,
      [
        "pi-tldr status",
        "enabled: yes",
        "selected model: auto",
        "active model: anthropic/claude-haiku-4-5",
      ].join("\n"),
    );
  });

  it("clears the widget and aborts stale work after an empty final stop", async () => {
    let abortSignal: AbortSignal | undefined;
    const widgets: Array<unknown> = [];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      preferredModelStore: createMemoryPreferredModelStore(),
      complete: async (_model, _context, options) => {
        abortSignal = options?.signal;
        return new Promise(() => undefined);
      },
    });
    const ctx = createFakeContext({ widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    await waitForTimers();

    assert.equal(abortSignal?.aborted, false);

    events.get("message_end")?.({ message: createAssistantResponse("") }, ctx);

    assert.equal(abortSignal?.aborted, true);
    assert.equal(widgets.at(-1), undefined);
  });
});
