import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  getAgentDir,
  type ExtensionContext,
  ModelSelectorComponent,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

export const TLDR_MODEL_FLAG = "tldr-model";

const TLDR_MODEL_CONFIG_FILE = "pi-tldr.json";
const AUTOMATIC_MODEL_CHOICE = "auto";
const AUTOMATIC_MODEL_PROVIDER = "pi-tldr";

export interface TldrModelPreference {
  readonly provider: string;
  readonly id: string;
}

export interface FastModelAuth {
  readonly model: Model<Api>;
  readonly apiKey: string;
  readonly headers?: Record<string, string>;
}

export interface PreferredModelStore {
  load(): string | undefined;
  save(modelSpec: string): string | undefined;
  clear(): string | undefined;
}

export type ModelPreferenceUpdate =
  | {
      readonly ok: true;
      readonly preferredModel?: TldrModelPreference;
      readonly notice: string;
    }
  | { readonly ok: false; readonly message: string };

type ModelSelectorRegistry = ConstructorParameters<
  typeof ModelSelectorComponent
>[3];

const FAST_MODEL_CANDIDATES: readonly TldrModelPreference[] = [
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
  { provider: "openai-codex", id: "gpt-5.4-mini" },
  { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
];

// UI-only sentinel for ModelSelectorComponent. It is translated to the
// `auto` preference before any completion request is made.
const AUTOMATIC_TLDR_MODEL: Model<Api> = {
  id: AUTOMATIC_MODEL_CHOICE,
  name: "Automatic",
  api: "pi-tldr-automatic",
  provider: AUTOMATIC_MODEL_PROVIDER,
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
};

const MODEL_SELECTOR_SETTINGS = SettingsManager.inMemory();

function tldrConfigPath(): string {
  return join(getAgentDir(), TLDR_MODEL_CONFIG_FILE);
}

function parsePreferredModelConfig(configText: string): string | undefined {
  try {
    const value = JSON.parse(configText) as { readonly model?: string } | null;
    return value && typeof value.model === "string" ? value.model : undefined;
  } catch {
    return undefined;
  }
}

function createFilePreferredModelStore(): PreferredModelStore {
  return {
    load() {
      try {
        const path = tldrConfigPath();
        if (!existsSync(path)) return undefined;
        return parsePreferredModelConfig(readFileSync(path, "utf8"));
      } catch {
        return undefined;
      }
    },
    save(modelSpec) {
      const path = tldrConfigPath();
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          `${JSON.stringify({ model: modelSpec }, null, 2)}\n`,
        );
      } catch {
        return "preference could not be saved";
      }
    },
    clear() {
      try {
        rmSync(tldrConfigPath(), { force: true });
      } catch {
        return "saved preference could not be removed";
      }
    },
  };
}

function formatModelSpec({ provider, id }: TldrModelPreference): string {
  return `${provider}/${id}`;
}

function formatRegistryModel({ provider, id }: Model<Api>): string {
  return `${provider}/${id}`;
}

function parseModelSpec(value: string): TldrModelPreference | undefined {
  const trimmed = value.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return undefined;
  return {
    provider: trimmed.slice(0, separator),
    id: trimmed.slice(separator + 1),
  };
}

function isSupportedTldrModel(candidate: TldrModelPreference): boolean {
  return FAST_MODEL_CANDIDATES.some(
    (supported) => formatModelSpec(supported) === formatModelSpec(candidate),
  );
}

function parseSupportedModelSpec(
  value: string,
): TldrModelPreference | undefined {
  const candidate = parseModelSpec(value);
  return candidate && isSupportedTldrModel(candidate) ? candidate : undefined;
}

function parseModelFlag(
  value: string | boolean | undefined,
): TldrModelPreference | undefined {
  return typeof value === "string" ? parseSupportedModelSpec(value) : undefined;
}

function supportedModelList(): string {
  return FAST_MODEL_CANDIDATES.map(formatModelSpec).join(", ");
}

function modelCandidates(
  preferredModel?: TldrModelPreference,
): readonly TldrModelPreference[] {
  if (!preferredModel) return FAST_MODEL_CANDIDATES;
  return [
    preferredModel,
    ...FAST_MODEL_CANDIDATES.filter(
      (candidate) =>
        formatModelSpec(candidate) !== formatModelSpec(preferredModel),
    ),
  ];
}

function isAutomaticModel({ provider, id }: Model<Api>): boolean {
  return provider === AUTOMATIC_MODEL_PROVIDER && id === AUTOMATIC_MODEL_CHOICE;
}

export function resolveInitialModelPreference(
  flagValue: string | boolean | undefined,
  store: PreferredModelStore = createFilePreferredModelStore(),
): TldrModelPreference | undefined {
  const savedModelSpec = store.load();
  return (
    parseModelFlag(flagValue) ??
    (savedModelSpec ? parseSupportedModelSpec(savedModelSpec) : undefined)
  );
}

export function applyModelPreferenceChoice(
  value: string,
  store: PreferredModelStore = createFilePreferredModelStore(),
): ModelPreferenceUpdate {
  if (value === AUTOMATIC_MODEL_CHOICE || value === "reset") {
    const warning = store.clear();
    return {
      ok: true,
      preferredModel: undefined,
      notice: warning
        ? `pi-tldr model set to auto, but ${warning}`
        : "pi-tldr model set to auto",
    };
  }

  const nextModel = parseSupportedModelSpec(value);
  if (!nextModel) {
    return {
      ok: false,
      message: `Use one of the supported pi-tldr models: ${supportedModelList()}`,
    };
  }

  const modelSpec = formatModelSpec(nextModel);
  const warning = store.save(modelSpec);
  return {
    ok: true,
    preferredModel: nextModel,
    notice: warning
      ? `pi-tldr model set to ${modelSpec}, but ${warning}`
      : `pi-tldr model set to ${modelSpec}`,
  };
}

function createModelSelectorRegistry(
  ctx: ExtensionContext,
): ModelSelectorRegistry {
  return new Proxy(ctx.modelRegistry, {
    get(target, property, receiver) {
      if (property === "find") {
        return (provider: string, id: string) =>
          provider === AUTOMATIC_MODEL_PROVIDER && id === AUTOMATIC_MODEL_CHOICE
            ? AUTOMATIC_TLDR_MODEL
            : target.find(provider, id);
      }

      if (property === "getAvailable") {
        return () => {
          const availableBySpec = new Map(
            target
              .getAvailable()
              .map((model) => [formatRegistryModel(model), model]),
          );
          return [
            AUTOMATIC_TLDR_MODEL,
            ...FAST_MODEL_CANDIDATES.map(formatModelSpec)
              .map((spec) => availableBySpec.get(spec))
              .filter((model): model is Model<Api> => model !== undefined),
          ];
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ModelSelectorRegistry;
}

export async function selectTldrModel(
  ctx: ExtensionContext,
  currentPreference?: TldrModelPreference,
): Promise<string | undefined> {
  const selectorRegistry = createModelSelectorRegistry(ctx);
  const currentModel = currentPreference
    ? (selectorRegistry.find(
        currentPreference.provider,
        currentPreference.id,
      ) ?? AUTOMATIC_TLDR_MODEL)
    : AUTOMATIC_TLDR_MODEL;

  const selectedModel = await ctx.ui.custom<Model<Api> | undefined>(
    (tui, theme, keybindings, done) => {
      void theme;
      void keybindings;
      return new ModelSelectorComponent(
        tui,
        currentModel,
        MODEL_SELECTOR_SETTINGS,
        selectorRegistry,
        [],
        (model) => done(model),
        () => done(undefined),
      );
    },
  );

  if (!selectedModel) return undefined;
  return isAutomaticModel(selectedModel)
    ? AUTOMATIC_MODEL_CHOICE
    : formatRegistryModel(selectedModel);
}

export async function getFastModelAuth(
  ctx: ExtensionContext,
  preferredModel?: TldrModelPreference,
): Promise<FastModelAuth | undefined> {
  for (const candidate of modelCandidates(preferredModel)) {
    const model = ctx.modelRegistry.find(candidate.provider, candidate.id);
    if (!model) continue;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok && auth.apiKey) {
      return { model, apiKey: auth.apiKey, headers: auth.headers };
    }
  }
  return undefined;
}
