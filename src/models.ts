/**
 * @fileoverview Model preference, settings, and auth resolution for TLDR calls.
 *
 * This module reads the extension's pi settings, parses optional provider/model
 * preferences, and selects the first authenticated fast model that can generate
 * live TLDRs.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const SETTINGS_KEY = "tldr";

export interface TldrModelPreference {
  readonly provider: string;
  readonly id: string;
}

export interface FastModelAuth {
  readonly model: Model<Api>;
  readonly apiKey: string;
  readonly headers?: Record<string, string>;
}

// The TLDR path optimizes for low latency and low cost rather than reasoning
// quality; these are deliberately fast fallback models already known to pi.
const FAST_MODEL_CANDIDATES: readonly TldrModelPreference[] = [
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
  { provider: "openai-codex", id: "gpt-5.4-mini" },
  { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
];

interface SettingsModelValue {
  readonly present: boolean;
  readonly value?: string;
}

export function formatModelPreference(
  configuredModel?: TldrModelPreference,
): string {
  return configuredModel ? formatTldrModelKey(configuredModel) : "auto";
}

export function formatTldrModelKey({
  provider,
  id,
}: TldrModelPreference): string {
  return `${provider}/${id}`;
}

export function formatAuthModelKey(auth: FastModelAuth): string {
  return `${auth.model.provider}/${auth.model.id}`;
}

/**
 * Parses a settings model string.
 *
 * Invalid strings and `auto` intentionally resolve to undefined so callers fall
 * back to automatic model selection instead of failing user sessions.
 */
function parseModelSpec(value: string): TldrModelPreference | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "auto") {
    return undefined;
  }

  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return undefined;
  }

  return {
    provider: trimmed.slice(0, separator),
    id: trimmed.slice(separator + 1),
  };
}

function settingsModelValue(
  settings: Record<string, unknown>,
  key: string,
): SettingsModelValue {
  const section = settings[key];
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { present: false };
  }

  const value = (section as Record<string, unknown>).model;
  return typeof value === "string"
    ? { present: true, value }
    : { present: "model" in section };
}

// SettingsManager owns global/project lookup. Passing pi's session cwd lets
// project-local `.pi/settings.json` override user-wide TLDR settings.
export function resolveInitialModelPreference(
  cwd: string,
): TldrModelPreference | undefined {
  const settings = SettingsManager.create(cwd);
  const projectModel = settingsModelValue(
    settings.getProjectSettings() as Record<string, unknown>,
    SETTINGS_KEY,
  );
  if (projectModel.present) {
    return projectModel.value ? parseModelSpec(projectModel.value) : undefined;
  }

  const userModel = settingsModelValue(
    settings.getGlobalSettings() as Record<string, unknown>,
    SETTINGS_KEY,
  );
  return userModel.value ? parseModelSpec(userModel.value) : undefined;
}

async function getModelAuth(
  ctx: ExtensionContext,
  modelPreference: TldrModelPreference,
): Promise<FastModelAuth | undefined> {
  const model = ctx.modelRegistry.find(
    modelPreference.provider,
    modelPreference.id,
  );
  if (!model) {
    return undefined;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  return auth.ok && auth.apiKey
    ? { model, apiKey: auth.apiKey, headers: auth.headers }
    : undefined;
}

export async function getFastModelAuth(
  ctx: ExtensionContext,
  configuredModel?: TldrModelPreference,
): Promise<FastModelAuth | undefined> {
  if (configuredModel) {
    const configuredAuth = await getModelAuth(ctx, configuredModel);
    if (configuredAuth) {
      return configuredAuth;
    }
  }

  for (const fallbackModel of FAST_MODEL_CANDIDATES) {
    if (
      configuredModel &&
      formatTldrModelKey(fallbackModel) === formatTldrModelKey(configuredModel)
    ) {
      continue;
    }

    const fallbackAuth = await getModelAuth(ctx, fallbackModel);
    if (fallbackAuth) {
      return fallbackAuth;
    }
  }

  return undefined;
}
