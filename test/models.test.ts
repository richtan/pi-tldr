/**
 * @fileoverview Tests for TLDR model configuration and authentication fallback.
 *
 * These tests verify pi settings precedence, automatic selection for invalid
 * configuration, configured-model priority, and fallback to authenticated fast
 * models when the preferred model is unavailable.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getFastModelAuth,
  resolveInitialModelPreference,
} from "../src/models.js";
import { fakeModel, writeModelSettings } from "./support/helpers.js";

function withHome<T>(home: string, run: () => T): T {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return run();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
}

describe("tldr model settings", () => {
  it("resolves project settings before user settings", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pi-tldr-settings-"));
    try {
      const home = join(tempDir, "home");
      const project = join(tempDir, "project");
      writeModelSettings(home, ".pi/agent", "anthropic/claude-haiku-4-5");
      writeModelSettings(project, ".pi", "openai-codex/gpt-5.4-mini");

      const preference = withHome(home, () =>
        resolveInitialModelPreference(project),
      );

      assert.deepEqual(preference, {
        provider: "openai-codex",
        id: "gpt-5.4-mini",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses user settings when project settings do not configure tldr", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pi-tldr-settings-"));
    try {
      const home = join(tempDir, "home");
      const project = join(tempDir, "project");
      mkdirSync(project, { recursive: true });
      writeModelSettings(home, ".pi/agent", "anthropic/claude-haiku-4-5");

      const preference = withHome(home, () =>
        resolveInitialModelPreference(project),
      );

      assert.deepEqual(preference, {
        provider: "anthropic",
        id: "claude-haiku-4-5",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats invalid or auto project settings as automatic selection", () => {
    for (const model of ["not-a-model", "auto"]) {
      const tempDir = mkdtempSync(join(tmpdir(), "pi-tldr-settings-"));
      try {
        writeModelSettings(tempDir, ".pi", model);
        assert.equal(resolveInitialModelPreference(tempDir), undefined);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("uses configured model auth first and falls back to automatic models", async () => {
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
    // Safe: this fake context implements the model auth members under test.
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

    const fallbackAuth = await getFastModelAuth(ctx, {
      provider: "missing",
      id: "model",
    });
    assert.equal(fallbackAuth?.model.provider, "openai-codex");
  });
});
