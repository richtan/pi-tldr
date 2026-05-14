/**
 * @fileoverview Shared test helpers for pi-tldr model and settings fixtures.
 *
 * This module centralizes fake model metadata, assistant responses, and temporary
 * pi settings files so tests can focus on behavior instead of repeated fixture
 * construction.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

/** Creates model metadata used by pi-tldr tests. */
export function fakeModel(
  provider = "anthropic",
  id = "claude-haiku-4-5",
): Model<Api> {
  // Safe: tests only exercise the model metadata fields below.
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

/** Creates an assistant response consumed by pi-tldr TLDR tests. */
export function assistantResponse(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  // Safe: tests only exercise assistant response fields consumed by pi-tldr.
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
  } as AssistantMessage;
}

/** Writes tldr model settings below a test root. */
export function writeModelSettings(
  root: string,
  relativeDir: string,
  model: string,
  settingsKey = "tldr",
): void {
  const settingsDir = join(root, relativeDir);
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    `${JSON.stringify({ [settingsKey]: { model } }, null, 2)}\n`,
  );
}

/** Creates a temporary cwd containing project-local tldr model settings. */
export function createSettingsCwd(model: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-tldr-settings-"));
  writeModelSettings(cwd, ".pi", model);
  return cwd;
}
