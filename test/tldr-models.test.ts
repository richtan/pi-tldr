import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyModelPreferenceChoice,
  type PreferredModelStore,
  resolveInitialModelPreference,
} from "../src/tldr-models.js";

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

  it("falls back to a valid saved preference when the flag is absent", () => {
    const store = fakeStore("anthropic/claude-haiku-4-5");

    assert.deepEqual(resolveInitialModelPreference(undefined, store), {
      provider: "anthropic",
      id: "claude-haiku-4-5",
    });
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

    assert.deepEqual(applyModelPreferenceChoice("auto", store), {
      ok: true,
      preferredModel: undefined,
      notice: "pi-tldr model set to auto",
    });
    assert.equal(store.cleared, true);
    assert.equal(store.saved, undefined);
  });
});
