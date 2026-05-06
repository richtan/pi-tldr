import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  applyModelPreferenceChoice,
  getFastModelAuth,
  type PreferredModelStore,
  resolveInitialModelPreference,
  selectTldrModel,
} from "../src/tldr-models.js";

function fakeModel(provider: string, id: string): Model<Api> {
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

function fakeStore(initial?: string): PreferredModelStore & {
  saved?: string;
  cleared: boolean;
} {
  return {
    saved: initial,
    cleared: false,
    load() {
      return this.saved;
    },
    save(modelSpec) {
      this.saved = modelSpec;
      this.cleared = false;
      return undefined;
    },
    clear() {
      this.saved = undefined;
      this.cleared = true;
      return undefined;
    },
  };
}

describe("tldr model preferences", () => {
  it("resolves a valid flag before saved preference", () => {
    const store = fakeStore("anthropic/claude-haiku-4-5");

    assert.deepEqual(
      resolveInitialModelPreference("openai-codex/gpt-5.4-mini", store),
      { provider: "openai-codex", id: "gpt-5.4-mini" },
    );
  });

  it("falls back to a valid saved preference when the flag is absent or invalid", () => {
    const store = fakeStore("anthropic/claude-haiku-4-5");

    assert.deepEqual(resolveInitialModelPreference(undefined, store), {
      provider: "anthropic",
      id: "claude-haiku-4-5",
    });
    assert.deepEqual(
      resolveInitialModelPreference("unsupported/model", store),
      {
        provider: "anthropic",
        id: "claude-haiku-4-5",
      },
    );
  });

  it("ignores unsupported choices", () => {
    const store = fakeStore("unsupported/model");

    assert.equal(resolveInitialModelPreference(undefined, store), undefined);
    assert.deepEqual(applyModelPreferenceChoice("unsupported/model", store), {
      ok: false,
      message:
        "Use one of the supported pi-tldr models: anthropic/claude-haiku-4-5, anthropic/claude-haiku-4-5-20251001, openai-codex/gpt-5.4-mini, openai-codex/gpt-5.3-codex-spark",
    });
  });

  it("saves supported direct choices and clears auto choices", () => {
    const store = fakeStore();

    assert.deepEqual(
      applyModelPreferenceChoice("openai-codex/gpt-5.3-codex-spark", store),
      {
        ok: true,
        preferredModel: {
          provider: "openai-codex",
          id: "gpt-5.3-codex-spark",
        },
        notice: "pi-tldr model set to openai-codex/gpt-5.3-codex-spark",
      },
    );
    assert.equal(store.saved, "openai-codex/gpt-5.3-codex-spark");

    assert.deepEqual(applyModelPreferenceChoice("reset", store), {
      ok: true,
      preferredModel: undefined,
      notice: "pi-tldr model set to auto",
    });
    assert.equal(store.cleared, true);
    assert.equal(store.saved, undefined);
  });

  it("includes persistence warnings in successful updates", () => {
    const store = fakeStore();
    store.save = (modelSpec) => {
      store.saved = modelSpec;
      return "preference could not be saved";
    };
    store.clear = () => "saved preference could not be removed";

    assert.deepEqual(
      applyModelPreferenceChoice("anthropic/claude-haiku-4-5", store),
      {
        ok: true,
        preferredModel: { provider: "anthropic", id: "claude-haiku-4-5" },
        notice:
          "pi-tldr model set to anthropic/claude-haiku-4-5, but preference could not be saved",
      },
    );
    assert.deepEqual(applyModelPreferenceChoice("auto", store), {
      ok: true,
      preferredModel: undefined,
      notice:
        "pi-tldr model set to auto, but saved preference could not be removed",
    });
  });

  it("selects explicit models and maps the automatic sentinel to auto", async () => {
    const selectedModel = fakeModel("openai-codex", "gpt-5.4-mini");
    const ctx = {
      modelRegistry: {
        find(provider: string, id: string) {
          return fakeModel(provider, id);
        },
        getAvailable() {
          return [selectedModel];
        },
      },
      ui: {
        async custom() {
          return selectedModel;
        },
      },
    } as unknown as ExtensionContext;

    assert.equal(
      await selectTldrModel(ctx, {
        provider: "openai-codex",
        id: "gpt-5.4-mini",
      }),
      "openai-codex/gpt-5.4-mini",
    );

    const autoCtx = {
      ...ctx,
      ui: {
        async custom() {
          return fakeModel("pi-tldr", "auto");
        },
      },
    } as unknown as ExtensionContext;

    assert.equal(await selectTldrModel(autoCtx), "auto");
  });

  it("uses preferred model auth first and falls back to supported models", async () => {
    const availableModels = new Map([
      [
        "anthropic/claude-haiku-4-5",
        fakeModel("anthropic", "claude-haiku-4-5"),
      ],
      ["openai-codex/gpt-5.4-mini", fakeModel("openai-codex", "gpt-5.4-mini")],
    ]);
    const authBySpec = new Map([
      ["anthropic/claude-haiku-4-5", { ok: false }],
      [
        "openai-codex/gpt-5.4-mini",
        { ok: true, apiKey: "test-key", headers: { "x-test": "yes" } },
      ],
    ]);
    const ctx = {
      modelRegistry: {
        find(provider: string, id: string) {
          return availableModels.get(`${provider}/${id}`);
        },
        async getApiKeyAndHeaders(model: Model<Api>) {
          return (
            authBySpec.get(`${model.provider}/${model.id}`) ?? { ok: false }
          );
        },
      },
    } as unknown as ExtensionContext;

    const auth = await getFastModelAuth(ctx, {
      provider: "openai-codex",
      id: "gpt-5.4-mini",
    });

    assert.equal(auth?.model.provider, "openai-codex");
    assert.equal(auth?.apiKey, "test-key");
    assert.deepEqual(auth?.headers, { "x-test": "yes" });

    const fallbackAuth = await getFastModelAuth(ctx);
    assert.equal(fallbackAuth?.model.provider, "openai-codex");
  });
});
