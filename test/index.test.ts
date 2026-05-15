/**
 * @fileoverview Integration-style tests for the pi-tldr extension entry point.
 *
 * These tests exercise command handling, lifecycle reset behavior, model auth
 * fallback, TLDR request scheduling, stale-work cancellation, and widget updates
 * through a fake pi extension runtime.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import type { Api, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createPiTldr,
  piTldr,
  type PiTldrDependencies,
  type TimerScheduler,
} from "../src/index.js";
import {
  assistantResponse,
  createSettingsCwd,
  fakeModel,
} from "./support/helpers.js";

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

function createFakePiHarness(): FakePiHarness {
  const commands = new Map<string, RegisteredCommand>();
  const events = new Map<string, EventHandler>();
  // Safe: the harness implements the ExtensionAPI members used by pi-tldr.
  const pi = {
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    on(name: string, handler: EventHandler) {
      events.set(name, handler);
    },
  } as unknown as ExtensionAPI;

  return { pi, commands, events };
}

interface FakeAuthResult {
  readonly ok: boolean;
  readonly apiKey?: string;
}
type FakeAuthProvider = (
  model: Model<Api>,
) => Promise<FakeAuthResult> | FakeAuthResult;

interface FakeContextOptions {
  readonly model?: Model<Api>;
  readonly models?: readonly Model<Api>[];
  readonly auth?: FakeAuthResult | FakeAuthProvider;
  readonly widgets?: unknown[];
  readonly cwd?: string;
  readonly notifications?: Array<{
    readonly message: string;
    readonly level: string;
  }>;
}

function createFakeContext(options: FakeContextOptions): ExtensionContext {
  const models = options.models ?? [options.model ?? fakeModel()];
  // Safe: the fake context implements the UI and model registry members used by pi-tldr.
  return {
    hasUI: true,
    cwd: options.cwd ?? process.cwd(),
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
  return waitForMs(5);
}

function waitForMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeTheme {
  fg(_name: string, value: string): string;
  bold(value: string): string;
}

type WidgetFactory = (
  tui: unknown,
  theme: FakeTheme,
) => { render(width: number): string[] };

const fakeTheme: FakeTheme = {
  fg(_name, value) {
    return value;
  },
  bold(value) {
    return value;
  },
};

function renderWidgetText(widget: unknown): string {
  assert.equal(typeof widget, "function");
  // Safe: fake pi contexts store widget factories with the same call shape that
  // the real TUI invokes when rendering a widget.
  const component = (widget as WidgetFactory)(undefined, fakeTheme);
  return component.render(80).join("\n");
}

interface FakeScheduledTask {
  readonly callback: () => void;
  readonly runAtMs: number;
  canceled: boolean;
}

class FakeScheduler implements TimerScheduler {
  private nowMs = 0;
  private readonly tasks: FakeScheduledTask[] = [];

  setTimeout(callback: () => void, delayMs: number): FakeScheduledTask {
    const task = {
      callback,
      runAtMs: this.nowMs + Math.max(0, delayMs),
      canceled: false,
    };
    this.tasks.push(task);
    return task;
  }

  clearTimeout(handle: unknown): void {
    // Safe: FakeScheduler only receives handles returned by its own setTimeout.
    (handle as FakeScheduledTask).canceled = true;
  }

  advanceBy(ms: number): void {
    const targetMs = this.nowMs + ms;

    while (true) {
      const nextTask = this.nextDueTask(targetMs);
      if (!nextTask) break;

      this.nowMs = nextTask.runAtMs;
      nextTask.canceled = true;
      nextTask.callback();
    }

    this.nowMs = targetMs;
  }

  private nextDueTask(targetMs: number): FakeScheduledTask | undefined {
    return this.tasks
      .filter((task) => !task.canceled && task.runAtMs <= targetMs)
      .sort((left, right) => left.runAtMs - right.runAtMs)[0];
  }
}

async function flushAsyncWork(): Promise<void> {
  for (let step = 0; step < 5; step++) {
    await Promise.resolve();
  }
}

function startExtension(
  dependencies: PiTldrDependencies = {},
  contextOptions: FakeContextOptions = {},
): FakePiHarness & { readonly ctx: ExtensionContext } {
  const harness = createFakePiHarness();
  const ctx = createFakeContext(contextOptions);
  createPiTldr(dependencies)(harness.pi);
  harness.events.get("session_start")?.({}, ctx);
  return { ...harness, ctx };
}

describe("piTldr extension entrypoint", () => {
  it("registers the command and lifecycle event handlers", () => {
    const commands: string[] = [];
    const events: string[] = [];
    // Safe: this test double implements only the registration methods used here.
    const pi = {
      registerCommand(name: string) {
        commands.push(name);
      },
      on(name: string) {
        events.push(name);
      },
    } as unknown as ExtensionAPI;

    piTldr(pi);

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

  it("shows available commands for bare /tldr", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { commands, ctx } = startExtension({}, { notifications });

    await commands.get("tldr")?.handler("", ctx);

    assert.deepEqual(notifications, [
      {
        level: "info",
        message: [
          "pi-tldr commands",
          "/tldr help - show this help",
          "/tldr status - show selected and active model status",
        ].join("\n"),
      },
    ]);
  });

  it("reports selected and active auto model status", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { commands, ctx } = startExtension({}, { notifications });

    await commands.get("tldr")?.handler("status", ctx);

    assert.deepEqual(notifications, [
      {
        level: "info",
        message: [
          "pi-tldr status",
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
    const { commands, ctx } = startExtension(
      {},
      { auth: { ok: false }, notifications },
    );

    await commands.get("tldr")?.handler("status", ctx);

    assert.equal(
      notifications.at(-1)?.message,
      ["pi-tldr status", "selected model: auto", "active model: none"].join(
        "\n",
      ),
    );
  });

  it("reports settings-selected models as selected and active", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const cwd = createSettingsCwd("openai-codex/gpt-5.4-mini");
    const { commands, ctx } = startExtension(
      {},
      {
        cwd,
        model: fakeModel("openai-codex", "gpt-5.4-mini"),
        notifications,
      },
    );

    try {
      await commands.get("tldr")?.handler("status", ctx);

      assert.equal(
        notifications.at(-1)?.message,
        [
          "pi-tldr status",
          "selected model: openai-codex/gpt-5.4-mini",
          "active model: openai-codex/gpt-5.4-mini",
        ].join("\n"),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports active fallback when a configured model is unavailable", async () => {
    const selectedModel = fakeModel("openai-codex", "gpt-5.4-mini");
    const fallbackModel = fakeModel("anthropic", "claude-haiku-4-5");
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const cwd = createSettingsCwd("openai-codex/gpt-5.4-mini");
    const { commands, ctx } = startExtension(
      {},
      {
        cwd,
        models: [selectedModel, fallbackModel],
        auth: (model) =>
          model.provider === selectedModel.provider
            ? { ok: false }
            : { ok: true, apiKey: "test-key" },
        notifications,
      },
    );

    try {
      await commands.get("tldr")?.handler("status", ctx);

      assert.equal(
        notifications.at(-1)?.message,
        [
          "pi-tldr status",
          "selected model: openai-codex/gpt-5.4-mini",
          "active model: anthropic/claude-haiku-4-5",
        ].join("\n"),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports active model auth check failures", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { commands, ctx } = startExtension(
      {},
      {
        auth: () => {
          throw new Error("auth failed");
        },
        notifications,
      },
    );

    await commands.get("tldr")?.handler("status", ctx);

    assert.equal(
      notifications.at(-1)?.message,
      [
        "pi-tldr status",
        "selected model: auto",
        "active model: unknown (auth check failed)",
      ].join("\n"),
    );
  });

  it("processes newer activity after a delayed checkpoint auth resolves", async () => {
    let authCalls = 0;
    let resolveFirstAuth: ((result: FakeAuthResult) => void) | undefined;
    const completionKeys: string[] = [];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      now: () => 0,
      generateTldr: async (_model, _context, options) => {
        completionKeys.push(options?.apiKey ?? "");
        return assistantResponse("Wrote latest TLDR.");
      },
    });
    const ctx = createFakeContext({
      auth: () => {
        authCalls++;
        if (authCalls === 1) {
          return new Promise<FakeAuthResult>((resolve) => {
            resolveFirstAuth = resolve;
          });
        }
        return { ok: true, apiKey: "fresh-key" };
      },
    });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "First run" }, ctx);
    await flushAsyncWork();

    assert.equal(authCalls, 1);

    events.get("message_update")?.(
      { message: assistantResponse("Writing a newer status") },
      ctx,
    );

    assert.equal(authCalls, 1);

    resolveFirstAuth?.({ ok: true, apiKey: "first-key" });
    await flushAsyncWork();
    await flushAsyncWork();

    assert.equal(authCalls, 2);
    assert.deepEqual(completionKeys, ["first-key", "fresh-key"]);
  });

  it("rechecks automatic fallback auth across agent runs", async () => {
    const scheduler = new FakeScheduler();
    let anthropicAvailable = false;
    const completionModels: string[] = [];
    const anthropicModel = fakeModel("anthropic", "claude-haiku-4-5");
    const openaiModel = fakeModel("openai-codex", "gpt-5.4-mini");
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      scheduler,
      now: () => 0,
      generateTldr: async (model, _context, options) => {
        completionModels.push(
          `${model.provider}/${model.id}:${options?.apiKey}`,
        );
        return assistantResponse(`Wrote TLDR with ${model.provider}.`);
      },
    });
    const ctx = createFakeContext({
      models: [anthropicModel, openaiModel],
      auth: (model) => {
        if (model.provider === "anthropic" && !anthropicAvailable) {
          return { ok: false };
        }
        return { ok: true, apiKey: `${model.provider}-key` };
      },
    });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "First run" }, ctx);
    scheduler.advanceBy(0);
    await flushAsyncWork();

    anthropicAvailable = true;
    events.get("before_agent_start")?.({ prompt: "Second run" }, ctx);
    scheduler.advanceBy(0);
    await flushAsyncWork();

    assert.deepEqual(completionModels, [
      "openai-codex/gpt-5.4-mini:openai-codex-key",
      "anthropic/claude-haiku-4-5:anthropic-key",
    ]);
  });

  it("rechecks configured-model fallback auth across agent runs", async () => {
    const scheduler = new FakeScheduler();
    let selectedAvailable = false;
    const completionModels: string[] = [];
    const selectedModel = fakeModel("openai-codex", "gpt-5.4-mini");
    const fallbackModel = fakeModel("anthropic", "claude-haiku-4-5");
    const cwd = createSettingsCwd("openai-codex/gpt-5.4-mini");
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      scheduler,
      now: () => 0,
      generateTldr: async (model, _context, options) => {
        completionModels.push(
          `${model.provider}/${model.id}:${options?.apiKey}`,
        );
        return assistantResponse(`Wrote TLDR with ${model.provider}.`);
      },
    });
    const ctx = createFakeContext({
      cwd,
      models: [selectedModel, fallbackModel],
      auth: (model) => {
        if (model.provider === "openai-codex" && !selectedAvailable) {
          return { ok: false };
        }
        return { ok: true, apiKey: `${model.provider}-key` };
      },
    });

    try {
      extension(pi);
      events.get("session_start")?.({}, ctx);
      events.get("before_agent_start")?.({ prompt: "First run" }, ctx);
      scheduler.advanceBy(0);
      await flushAsyncWork();

      selectedAvailable = true;
      events.get("before_agent_start")?.({ prompt: "Second run" }, ctx);
      scheduler.advanceBy(0);
      await flushAsyncWork();

      assert.deepEqual(completionModels, [
        "anthropic/claude-haiku-4-5:anthropic-key",
        "openai-codex/gpt-5.4-mini:openai-codex-key",
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports the model selected when status was invoked", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const openaiModel = fakeModel("openai-codex", "gpt-5.4-mini");
    const anthropicModel = fakeModel("anthropic", "claude-haiku-4-5");
    const openaiCwd = createSettingsCwd("openai-codex/gpt-5.4-mini");
    const anthropicCwd = createSettingsCwd("anthropic/claude-haiku-4-5");
    const { pi, commands, events } = createFakePiHarness();

    try {
      const laterCtx = createFakeContext({
        cwd: anthropicCwd,
        models: [openaiModel, anthropicModel],
        notifications,
      });
      const statusCtx = createFakeContext({
        cwd: openaiCwd,
        models: [openaiModel, anthropicModel],
        notifications,
        auth: () => {
          events.get("session_start")?.({}, laterCtx);
          return { ok: true, apiKey: "test-key" };
        },
      });

      createPiTldr()(pi);
      events.get("session_start")?.({}, statusCtx);
      await commands.get("tldr")?.handler("status", statusCtx);

      assert.equal(
        notifications.at(-1)?.message,
        [
          "pi-tldr status",
          "selected model: openai-codex/gpt-5.4-mini",
          "active model: openai-codex/gpt-5.4-mini",
        ].join("\n"),
      );
    } finally {
      rmSync(openaiCwd, { recursive: true, force: true });
      rmSync(anthropicCwd, { recursive: true, force: true });
    }
  });

  it("does not display stale checkpoints when newer activity exists", async () => {
    const widgets: unknown[] = [];
    const completions: Array<{
      readonly resolve: (
        response: ReturnType<typeof assistantResponse>,
      ) => void;
    }> = [];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      now: () => 0,
      generateTldr: async () =>
        new Promise<ReturnType<typeof assistantResponse>>((resolve) => {
          completions.push({ resolve });
        }),
    });
    const ctx = createFakeContext({ widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    await flushAsyncWork();

    assert.equal(completions.length, 1);

    events.get("message_update")?.(
      { message: assistantResponse("Still working") },
      ctx,
    );
    await flushAsyncWork();

    completions[0]?.resolve(assistantResponse("Stale status."));
    await flushAsyncWork();

    assert.equal(
      widgets.filter((widget) => typeof widget === "function").length,
      0,
    );
    assert.equal(completions.length, 2);

    completions[1]?.resolve(assistantResponse("Current status."));
    await flushAsyncWork();

    assert.match(renderWidgetText(widgets.at(-1)), /Current status\./);
  });

  it("generates checkpoint targets for every activity sequentially", async () => {
    const completions: Array<{
      readonly context: string;
      readonly systemPrompt: string;
      readonly resolve: (
        response: ReturnType<typeof assistantResponse>,
      ) => void;
    }> = [];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      now: () => 0,
      generateTldr: async (_model, context) =>
        new Promise<ReturnType<typeof assistantResponse>>((resolve) => {
          completions.push({
            context: JSON.stringify(context),
            systemPrompt: context.systemPrompt ?? "",
            resolve,
          });
        }),
    });
    const ctx = createFakeContext({});

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "tool-1",
        input: { command: "npm test" },
      },
      ctx,
    );
    await flushAsyncWork();

    assert.equal(completions.length, 1);
    assert.match(completions[0]?.systemPrompt ?? "", /one plain-English TLDR/);
    assert.match(completions[0]?.systemPrompt ?? "", /prior TLDRs for context/);
    assert.match(completions[0]?.systemPrompt ?? "", /requested index/);
    assert.match(
      completions[0]?.systemPrompt ?? "",
      /summarize the available activity/,
    );
    assert.match(
      completions[0]?.systemPrompt ?? "",
      /Never ask for more information/,
    );
    assert.match(completions[0]?.systemPrompt ?? "", /present-tense/);
    assert.doesNotMatch(completions[0]?.systemPrompt ?? "", /past-tense/);
    assert.match(completions[0]?.context ?? "", /Previous generated TLDR/);
    assert.match(completions[0]?.context ?? "", /none/);
    assert.match(completions[0]?.context ?? "", /\[1\] tool_call/);

    events.get("tool_result")?.(
      {
        toolName: "bash",
        toolCallId: "tool-1",
        isError: false,
        content: [{ type: "text", text: "Tests passed" }],
      },
      ctx,
    );
    await flushAsyncWork();

    assert.equal(completions.length, 1);

    completions[0]?.resolve(assistantResponse("Checking command results."));
    await flushAsyncWork();

    assert.equal(completions.length, 2);
    assert.match(
      completions[1]?.context ?? "",
      /Through activity 1: Checking command results\./,
    );
    assert.doesNotMatch(completions[1]?.context ?? "", /\[1\] tool_call/);
    assert.match(completions[1]?.context ?? "", /\[2\] tool_result/);
    assert.match(completions[1]?.context ?? "", /Tests passed/);
  });

  it("keeps only the latest queued normal checkpoint target", async () => {
    const completions: Array<{
      readonly context: string;
      readonly resolve: (
        response: ReturnType<typeof assistantResponse>,
      ) => void;
    }> = [];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      now: () => 0,
      generateTldr: async (_model, context) =>
        new Promise<ReturnType<typeof assistantResponse>>((resolve) => {
          completions.push({ context: JSON.stringify(context), resolve });
        }),
    });
    const ctx = createFakeContext({});

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    await flushAsyncWork();

    assert.equal(completions.length, 1);

    events.get("tool_call")?.(
      { toolName: "bash", toolCallId: "tool-1", input: {} },
      ctx,
    );
    events.get("tool_result")?.(
      {
        toolName: "bash",
        toolCallId: "tool-1",
        isError: false,
        content: [{ type: "text", text: "Tests passed" }],
      },
      ctx,
    );
    events.get("message_update")?.(
      { message: assistantResponse("Still working") },
      ctx,
    );
    await flushAsyncWork();

    completions[0]?.resolve(assistantResponse("Initial status."));
    await flushAsyncWork();

    assert.equal(completions.length, 2);
    assert.match(
      completions[1]?.context ?? "",
      /Through activity 1: Initial status\./,
    );
    assert.match(completions[1]?.context ?? "", /\[2\] tool_call/);
    assert.match(completions[1]?.context ?? "", /\[3\] tool_result/);
    assert.match(completions[1]?.context ?? "", /\[4\] assistant_update/);

    completions[1]?.resolve(assistantResponse("Latest normal status."));
    await flushAsyncWork();

    assert.equal(completions.length, 2);
  });

  it("final checkpoints supersede in-flight normal checkpoint generation", async () => {
    const widgets: unknown[] = [];
    const completions: Array<{
      readonly context: string;
      readonly systemPrompt: string;
      readonly options?: ProviderStreamOptions;
      readonly resolve: (
        response: ReturnType<typeof assistantResponse>,
      ) => void;
    }> = [];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      now: () => 0,
      generateTldr: async (_model, context, options) =>
        new Promise<ReturnType<typeof assistantResponse>>((resolve) => {
          completions.push({
            context: JSON.stringify(context),
            systemPrompt: context.systemPrompt ?? "",
            options,
            resolve,
          });
        }),
    });
    const ctx = createFakeContext({ widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "tool-1",
        input: { command: "npm test" },
      },
      ctx,
    );
    await flushAsyncWork();

    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.options?.signal?.aborted, false);

    events.get("message_end")?.(
      { message: assistantResponse("All done.") },
      ctx,
    );
    await flushAsyncWork();

    assert.equal(completions[0]?.options?.signal?.aborted, true);
    assert.equal(completions.length, 2);
    assert.match(completions[1]?.context ?? "", /\[1\] tool_call/);
    assert.match(completions[1]?.context ?? "", /\[2\] assistant_final/);
    assert.match(completions[1]?.context ?? "", /Assistant final response/);
    assert.match(completions[1]?.systemPrompt ?? "", /past-tense/);
    assert.doesNotMatch(completions[1]?.systemPrompt ?? "", /present-tense/);

    completions[0]?.resolve(assistantResponse("Stale normal status."));
    await flushAsyncWork();

    assert.equal(
      widgets.filter((widget) => typeof widget === "function").length,
      0,
    );

    completions[1]?.resolve(assistantResponse("Final status."));
    await flushAsyncWork();

    assert.match(renderWidgetText(widgets.at(-1)), /Final status\./);
  });

  it("user-message checkpoints supersede in-flight final checkpoint generation", async () => {
    const widgets: unknown[] = [];
    const completions: Array<{
      readonly context: string;
      readonly options?: ProviderStreamOptions;
      readonly resolve: (
        response: ReturnType<typeof assistantResponse>,
      ) => void;
    }> = [];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      now: () => 0,
      generateTldr: async (_model, context, options) =>
        new Promise<ReturnType<typeof assistantResponse>>((resolve) => {
          completions.push({
            context: JSON.stringify(context),
            options,
            resolve,
          });
        }),
    });
    const ctx = createFakeContext({ widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    await flushAsyncWork();

    assert.equal(completions.length, 1);
    completions[0]?.resolve(assistantResponse("Initial status."));
    await flushAsyncWork();

    events.get("message_end")?.(
      { message: assistantResponse("All done.") },
      ctx,
    );
    await flushAsyncWork();

    assert.equal(completions.length, 2);
    assert.equal(completions[1]?.options?.signal?.aborted, false);

    events.get("before_agent_start")?.({ prompt: "Follow up" }, ctx);
    await flushAsyncWork();

    assert.equal(completions[1]?.options?.signal?.aborted, true);
    assert.equal(completions.length, 3);
    assert.match(completions[2]?.context ?? "", /User message: Follow up/);

    completions[1]?.resolve(assistantResponse("Stale final status."));
    await flushAsyncWork();

    assert.equal(widgets.at(-1), undefined);

    completions[2]?.resolve(assistantResponse("Follow-up status."));
    await flushAsyncWork();

    assert.match(renderWidgetText(widgets.at(-1)), /Follow-up status\./);

    events.get("message_update")?.(
      { message: assistantResponse("Continuing the follow-up") },
      ctx,
    );
    await flushAsyncWork();

    assert.equal(completions.length, 4);
    assert.doesNotMatch(completions[3]?.context ?? "", /Stale final status/);
    assert.match(
      completions[3]?.context ?? "",
      /Through activity 3: Follow-up status\./,
    );
  });

  it("does not abort in-flight normal checkpoints when newer normal activity queues", async () => {
    const completions: Array<{
      readonly context: string;
      readonly options?: ProviderStreamOptions;
      readonly resolve: (
        response: ReturnType<typeof assistantResponse>,
      ) => void;
    }> = [];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      now: () => 0,
      generateTldr: async (_model, context, options) =>
        new Promise<ReturnType<typeof assistantResponse>>((resolve) => {
          completions.push({
            context: JSON.stringify(context),
            options,
            resolve,
          });
        }),
    });
    const ctx = createFakeContext({});

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("tool_call")?.(
      {
        toolName: "bash",
        toolCallId: "tool-1",
        input: { command: "npm test" },
      },
      ctx,
    );
    await flushAsyncWork();

    assert.equal(completions.length, 1);
    assert.match(completions[0]?.context ?? "", /\[1\] tool_call/);
    assert.equal(completions[0]?.options?.signal?.aborted, false);

    events.get("tool_result")?.(
      {
        toolName: "bash",
        toolCallId: "tool-1",
        isError: false,
        content: [{ type: "text", text: "Tests passed" }],
      },
      ctx,
    );
    await flushAsyncWork();

    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.options?.signal?.aborted, false);

    completions[0]?.resolve(assistantResponse("Running command output."));
    await flushAsyncWork();

    assert.equal(completions.length, 2);
    assert.match(completions[1]?.context ?? "", /\[2\] tool_result/);
  });

  it("throttles normal checkpoint display and renders the latest pending checkpoint", async () => {
    const scheduler = new FakeScheduler();
    let now = 0;
    const widgets: unknown[] = [];
    const outputs = [
      "Initial status.",
      "Tool call status.",
      "Tool result status.",
    ];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      scheduler,
      now: () => now,
      displayUpdateIntervalMs: 1_200,
      generateTldr: async () => assistantResponse(outputs.shift() ?? ""),
    });
    const ctx = createFakeContext({ widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    await flushAsyncWork();

    assert.match(renderWidgetText(widgets.at(-1)), /Initial status\./);

    events.get("tool_call")?.(
      { toolName: "bash", toolCallId: "tool-1", input: {} },
      ctx,
    );
    await flushAsyncWork();
    events.get("tool_result")?.(
      {
        toolName: "bash",
        toolCallId: "tool-1",
        isError: false,
        content: [{ type: "text", text: "Tests passed" }],
      },
      ctx,
    );
    await flushAsyncWork();

    assert.match(renderWidgetText(widgets.at(-1)), /Initial status\./);

    scheduler.advanceBy(1_199);
    assert.match(renderWidgetText(widgets.at(-1)), /Initial status\./);

    now = 1_200;
    scheduler.advanceBy(1);

    assert.match(renderWidgetText(widgets.at(-1)), /Tool result status\./);
  });

  it("lets final checkpoints bypass display throttling and clear pending normal output", async () => {
    const scheduler = new FakeScheduler();
    let now = 0;
    const widgets: unknown[] = [];
    const outputs = ["Initial status.", "Tool call status.", "Final status."];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      scheduler,
      now: () => now,
      displayUpdateIntervalMs: 1_200,
      generateTldr: async () => assistantResponse(outputs.shift() ?? ""),
    });
    const ctx = createFakeContext({ widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    await flushAsyncWork();

    events.get("tool_call")?.(
      { toolName: "bash", toolCallId: "tool-1", input: {} },
      ctx,
    );
    await flushAsyncWork();

    assert.match(renderWidgetText(widgets.at(-1)), /Initial status\./);

    events.get("message_end")?.(
      { message: assistantResponse("All done.") },
      ctx,
    );
    await flushAsyncWork();

    assert.match(renderWidgetText(widgets.at(-1)), /Final status\./);

    now = 1_200;
    scheduler.advanceBy(1_200);

    assert.match(renderWidgetText(widgets.at(-1)), /Final status\./);
  });

  it("lets immediate user-message checkpoints bypass display throttling", async () => {
    const scheduler = new FakeScheduler();
    const widgets: unknown[] = [];
    const outputs = ["Initial status.", "Follow-up status."];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      scheduler,
      now: () => 0,
      displayUpdateIntervalMs: 1_200,
      generateTldr: async () => assistantResponse(outputs.shift() ?? ""),
    });
    const ctx = createFakeContext({ widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    await flushAsyncWork();

    assert.match(renderWidgetText(widgets.at(-1)), /Initial status\./);

    events.get("before_agent_start")?.({ prompt: "Follow up" }, ctx);
    await flushAsyncWork();

    assert.match(renderWidgetText(widgets.at(-1)), /Follow-up status\./);
  });

  it("renders non-empty TLDR model output as-is", async () => {
    const widgets: unknown[] = [];
    const outputs = [
      "- Inspecting files",
      "[Inspecting](https://example.test)",
      "<status>Inspecting</status>",
      '{"status":"running"}',
      "Line one\nLine two",
      "a".repeat(221),
    ];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      now: () => 0,
      generateTldr: async () => assistantResponse(outputs.shift() ?? ""),
    });
    const ctx = createFakeContext({ widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    for (const prompt of ["one", "two", "three", "four", "five", "six"]) {
      events.get("before_agent_start")?.({ prompt }, ctx);
      await flushAsyncWork();
    }

    assert.equal(
      widgets.filter((widget) => typeof widget === "function").length,
      6,
    );
  });

  it("sanitizes TLDR model output before rendering", async () => {
    const widgets: unknown[] = [];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      now: () => 0,
      generateTldr: async () =>
        assistantResponse(
          [
            "\u001b]52;c;Y2xpcGJvYXJk\u0007",
            "\u001b[31mInspecting\u001b[0m",
            "files\u0000",
            "\u001b]8;;https://evil.test\u001b\\link\u001b]8;;\u001b\\",
          ].join("\n"),
        ),
    });
    const ctx = createFakeContext({ widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "one" }, ctx);
    await flushAsyncWork();

    const rendered = renderWidgetText(widgets.at(-1));
    assert.match(rendered, /Inspecting files link/);
    assert.doesNotMatch(
      rendered,
      /\u001b|\u0000|\u0007|evil\.test|Y2xpcGJvYXJk/,
    );
  });

  it("does not render empty TLDR model output", async () => {
    const widgets: unknown[] = [];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      now: () => 0,
      generateTldr: async () => assistantResponse(""),
    });
    const ctx = createFakeContext({ widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "one" }, ctx);
    await flushAsyncWork();

    assert.equal(
      widgets.filter((widget) => typeof widget === "function").length,
      0,
    );
  });

  it("drives a prompt-start TLDR into the widget", async () => {
    const widgets: unknown[] = [];
    const { pi, events } = createFakePiHarness();
    const completeCalls: Array<{ options?: ProviderStreamOptions }> = [];
    const extension = createPiTldr({
      generateTldr: async (_model, _context, options) => {
        completeCalls.push({ options });
        return assistantResponse("Inspecting repository status.");
      },
    });
    const ctx = createFakeContext({ widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    await waitForTimers();

    assert.equal(completeCalls.length, 1);
    assert.equal(completeCalls[0]?.options?.cacheRetention, "none");
    assert.equal(completeCalls[0]?.options?.timeoutMs, 2_000);
    assert.equal(widgets.length, 3);
    assert.equal(widgets[0], undefined);
    assert.equal(widgets[1], undefined);
    assert.equal(typeof widgets[2], "function");
  });

  it("aborts in-flight TLDR work and clears the widget on session shutdown", async () => {
    let completionCalls = 0;
    let abortSignal: AbortSignal | undefined;
    const scheduler = new FakeScheduler();
    const widgets: unknown[] = [];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      toolActivityCoalesceMs: 0,
      scheduler,
      now: () => 0,
      generateTldr: async (_model, _context, options) => {
        completionCalls++;
        if (completionCalls === 1) {
          return assistantResponse("Inspecting repository status.");
        }

        abortSignal = options?.signal;
        return new Promise(() => undefined);
      },
    });
    const ctx = createFakeContext({ widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "Check status" }, ctx);
    scheduler.advanceBy(0);
    await flushAsyncWork();

    assert.equal(typeof widgets.at(-1), "function");

    events.get("tool_call")?.(
      {
        toolName: "read",
        toolCallId: "tool-1",
        input: { path: "README.md" },
      },
      ctx,
    );
    scheduler.advanceBy(0);
    await flushAsyncWork();

    assert.equal(abortSignal?.aborted, false);

    events.get("session_shutdown")?.({}, ctx);

    assert.equal(abortSignal?.aborted, true);
    assert.equal(widgets.at(-1), undefined);
  });

  it("reports invalid /tldr actions", async () => {
    const notifications: Array<{
      readonly message: string;
      readonly level: string;
    }> = [];
    const { commands, ctx } = startExtension({}, { notifications });

    await commands.get("tldr")?.handler("later", ctx);
    await commands.get("tldr")?.handler("stats", ctx);
    await commands.get("tldr")?.handler("debug status", ctx);

    assert.deepEqual(notifications, [
      { message: "Use /tldr [help|status]", level: "error" },
      { message: "Use /tldr [help|status]", level: "error" },
      { message: "Use /tldr [help|status]", level: "error" },
    ]);
  });

  it("clears stale raw activity after an empty final stop", async () => {
    let abortSignal: AbortSignal | undefined;
    const widgets: unknown[] = [];
    const completions: Array<{ readonly context: string }> = [];
    const { pi, events } = createFakePiHarness();
    const extension = createPiTldr({
      generateTldr: async (_model, context, options) => {
        abortSignal = options?.signal;
        completions.push({ context: JSON.stringify(context) });
        return new Promise(() => undefined);
      },
    });
    const ctx = createFakeContext({ widgets });

    extension(pi);
    events.get("session_start")?.({}, ctx);
    events.get("before_agent_start")?.({ prompt: "First prompt" }, ctx);
    await waitForTimers();

    assert.equal(abortSignal?.aborted, false);

    events.get("message_update")?.(
      { message: assistantResponse("Working on the first prompt") },
      ctx,
    );
    events.get("message_end")?.({ message: assistantResponse("") }, ctx);

    assert.equal(abortSignal?.aborted, true);
    assert.equal(widgets.at(-1), undefined);

    events.get("before_agent_start")?.({ prompt: "Second prompt" }, ctx);
    await waitForTimers();

    assert.equal(completions.length, 2);
    assert.match(completions[1]?.context ?? "", /User message: Second prompt/);
    assert.doesNotMatch(completions[1]?.context ?? "", /First prompt/);
    assert.doesNotMatch(completions[1]?.context ?? "", /Working on the first/);
  });
});
