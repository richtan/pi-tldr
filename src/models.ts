/**
 * @fileoverview Model preference, settings, and auth resolution for TLDR calls.
 *
 * This module reads the extension's pi settings, parses optional provider/model
 * preferences, and selects the first authenticated fast model that can generate
 * live TLDRs.
 */
import { Api, Model } from "@mariozechner/pi-ai";
import {
  ExtensionContext,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

const SETTINGS_KEY = "pi-tldr";

/** Provider/model choice for TLDR completions. */
export interface TldrModelPreference {
  /** Model provider name as registered with pi. */
  readonly provider: string;
  /** Provider-local model id. */
  readonly id: string;
}

/** Authenticated model selected for one TLDR completion. */
export interface FastModelAuth {
  /** Model metadata from pi's model registry. */
  readonly model: Model<Api>;
  /** API key to pass to the provider. */
  readonly apiKey: string;
  /** Optional provider headers returned by pi's auth registry. */
  readonly headers?: Record<string, string>;
}

/** Fast models tried when the user has not configured a TLDR model. */
const FAST_MODEL_CANDIDATES: readonly TldrModelPreference[] = [
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
  { provider: "openai-codex", id: "gpt-5.4-mini" },
  { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
];

/** Parsed presence/value state for the `pi-tldr.model` setting. */
interface SettingsModelValue {
  readonly present: boolean;
  readonly value?: string;
}

/**
 * Formats a selected model for user-visible status output.
 *
 * @param configuredModel Configured model, or undefined for automatic selection.
 * @returns `provider/id` or `auto`.
 */
export function formatModelPreference(
  configuredModel?: TldrModelPreference,
): string {
  return configuredModel ? formatTldrModelKey(configuredModel) : "auto";
}

/** Formats a model preference as `provider/id`. */
export function formatTldrModelKey({
  provider,
  id,
}: TldrModelPreference): string {
  return `${provider}/${id}`;
}

/** Formats authenticated model metadata as `provider/id`. */
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

/** Extracts the optional `pi-tldr.model` setting from parsed settings. */
function settingsModelValue(
  settings: Record<string, unknown>,
): SettingsModelValue {
  const section = settings[SETTINGS_KEY];
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { present: false };
  }

  const value = (section as Record<string, unknown>).model;
  return typeof value === "string"
    ? { present: true, value }
    : { present: "model" in section };
}

/**
 * Resolves the configured model from pi settings.
 *
 * Pi's `SettingsManager` owns global and project settings path resolution. Its
 * project scope is `<cwd>/.pi/settings.json`, so callers should pass the pi
 * session's project working directory.
 *
 * @param cwd Current pi working directory used for project settings.
 * @returns Configured model preference, or undefined for automatic selection.
 */
export function resolveInitialModelPreference(
  cwd: string,
): TldrModelPreference | undefined {
  const settings = SettingsManager.create(cwd);
  const projectModel = settingsModelValue(
    settings.getProjectSettings() as Record<string, unknown>,
  );
  if (projectModel.present) {
    return projectModel.value ? parseModelSpec(projectModel.value) : undefined;
  }

  const userModel = settingsModelValue(
    settings.getGlobalSettings() as Record<string, unknown>,
  );
  return userModel.value ? parseModelSpec(userModel.value) : undefined;
}

/** Returns auth for one exact model preference, or undefined if unavailable. */
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

/**
 * Finds the first available authenticated TLDR model.
 *
 * @param ctx pi extension context containing model registry/auth access.
 * @param configuredModel Optional configured model to try before fallbacks.
 * @returns Authenticated model info, or undefined when no candidate is usable.
 */
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
