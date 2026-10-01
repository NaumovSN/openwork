import { DESKTOP_FREE_LEGACY_MODEL_ID } from "@openwork/free-auto";
import { ANONYMOUS_INFERENCE_MODEL_ID, ANONYMOUS_INFERENCE_PROVIDER_NAME, LOCAL_ROUTE_PREFIX } from "./settings.js";
import { isRecord } from "./http.js";

/** The engine-facing provider entry this service owns in the runtime OpenCode config. */
/** The model's own limits, as with paid Models; the Gateway does not cap Auto's context or output. */
const AUTO_LIMIT = { context: 1_050_000, input: 922_000, output: 128_000 };
/** Written by earlier builds; still ours, and rewritten to the current shape on the next start. */
const PREVIOUS_AUTO_LIMIT = { context: 135_168, input: 131_072, output: 4_096 };
function generatedModel(id = ANONYMOUS_INFERENCE_MODEL_ID, limit = AUTO_LIMIT, legacy = false) {
  return {
    id, name: legacy ? "GPT-5.6 Luna" : "GPT-6 Luna", attachment: false, reasoning: false, temperature: false, tool_call: true,
    options: legacy ? { reasoningEffort: "none" } : { reasoningEffort: "none", store: false },
    limit,
    modalities: { input: ["text"], output: ["text"] },
  };
}
function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
export function ownedProvider(localAccessToken: string, boundPort: number) {
  return {
    name: ANONYMOUS_INFERENCE_PROVIDER_NAME, npm: "@ai-sdk/openai",
    options: { apiKey: localAccessToken, baseURL: `http://127.0.0.1:${boundPort}${LOCAL_ROUTE_PREFIX}` },
    models: { [ANONYMOUS_INFERENCE_MODEL_ID]: generatedModel() },
  };
}
/** True only for an entry exactly as `ownedProvider` writes it; anything the user edited is left alone. */
export function isOwnedProvider(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "npm", "options", "models"])
    || value.name !== ANONYMOUS_INFERENCE_PROVIDER_NAME || (value.npm !== "@ai-sdk/openai" && value.npm !== "@ai-sdk/openai-compatible")
    || !isRecord(value.options) || !hasExactKeys(value.options, ["apiKey", "baseURL"])
    || typeof value.options.apiKey !== "string" || !/^owf_local_[A-Za-z0-9_-]{43}$/.test(value.options.apiKey)
    || typeof value.options.baseURL !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/anonymous-inference\/v1$/.test(value.options.baseURL)
    || !isRecord(value.models) || Object.keys(value.models).length !== 1) return false;
  const legacy = value.npm === "@ai-sdk/openai-compatible";
  const id = legacy ? DESKTOP_FREE_LEGACY_MODEL_ID : ANONYMOUS_INFERENCE_MODEL_ID;
  const model = value.models[id];
  if (!isRecord(model) || !hasExactKeys(model, Object.keys(generatedModel()))) return false;
  return [generatedModel(id, AUTO_LIMIT, legacy), generatedModel(id, PREVIOUS_AUTO_LIMIT, legacy)]
    .some((generated) => Object.entries(generated).every(([key, expected]) => JSON.stringify(model[key]) === JSON.stringify(expected)));
}
