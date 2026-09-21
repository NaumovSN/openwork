import { INFERENCE_USAGE_CONVERSION_FACTOR, readFreeInferenceConfig } from "@openwork/types/den/inference"
import { DESKTOP_FREE_RELEASE_URL } from "./desktop-free-version.js"

export function readAutoConfig(environment: Record<string, string | undefined>) {
  const member = readFreeInferenceConfig(environment)
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = environment[name]
    const value = Number(raw ?? fallback)
    if (raw?.trim() === "" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`)
    return value
  }
  const flag = (name: string) => {
    const value = environment[name] ?? "false"
    if (!["true", "false", "1", "0"].includes(value)) throw new Error(`Invalid ${name}`)
    return value === "true" || value === "1"
  }
  const deviceWeeklyAmount = integer("ANONYMOUS_INSTALL_WEEKLY_MICRO_USD", 1000000, 1, 100000000) * 100
  if (member.enabled && member.weeklyLimitAmount <= deviceWeeklyAmount) throw new Error("Member free budget must exceed the device budget")
  const apiKey = environment.INFERENCE_FREE_UPSTREAM_API_KEY?.trim() || environment.ANONYMOUS_OPENROUTER_API_KEY?.trim() || ""
  const provider = environment.ANONYMOUS_OPENROUTER_PROVIDER?.trim() || ""
  const byokOnly = flag("ANONYMOUS_OPENROUTER_BYOK_ONLY_VERIFIED")
  const tokenSecret = environment.ANONYMOUS_TOKEN_SECRET?.trim() || ""
  const accountingIdentityKey = environment.ANONYMOUS_ACCOUNTING_IDENTITY_KEY?.trim() || ""
  const ready = Boolean(apiKey && provider && byokOnly && accountingIdentityKey.length >= 32)
  return {
    member, memberEnabled: member.enabled && ready,
    anonymousEnabled: flag("ANONYMOUS_INFERENCE_ENABLED") && ready && tokenSecret.length >= 32 && tokenSecret !== accountingIdentityKey,
    apiKey, provider, tokenSecret, accountingIdentityKey,
    versionUrl: environment.DESKTOP_FREE_APP_VERSION_URL ?? DESKTOP_FREE_RELEASE_URL,
    deviceWeeklyAmount,
    ipDailyAmount: integer("ANONYMOUS_IP_DAILY_MICRO_USD", 5000000, 1, 100000000) * 100,
    globalDailyAmount: integer("ANONYMOUS_GLOBAL_DAILY_MICRO_USD", 100000000, 1, 1000000000) * 100,
    globalMonthlyAmount: integer("ANONYMOUS_GLOBAL_MONTHLY_MICRO_USD", 3000000000, 1, 10000000000) * 100,
    globalInflight: integer("ANONYMOUS_GLOBAL_INFLIGHT", 20, 1, 1000),
    tokenTtlSeconds: integer("ANONYMOUS_TOKEN_TTL_SECONDS", 3600, 60, 86400),
    requestTimeoutMs: integer("ANONYMOUS_REQUEST_TIMEOUT_MS", 60000, 1000, 300000),
    maxInputTokens: integer("ANONYMOUS_MAX_INPUT_TOKENS", 131072, 4096, 131072),
    maxCompletionTokens: integer("ANONYMOUS_MAX_COMPLETION_TOKENS", 4096, 1, 16384),
    maxInputPrice: integer("ANONYMOUS_MAX_INPUT_PRICE_MICRO_USD_PER_MILLION", 250000, 1, 100000000) / 1000000,
    maxCompletionPrice: integer("ANONYMOUS_MAX_COMPLETION_PRICE_MICRO_USD_PER_MILLION", 1200000, 1, 100000000) / 1000000,
    maxBodyBytes: integer("ANONYMOUS_MAX_BODY_BYTES", 262144, 1024, 1048576),
    maxResponseBytes: integer("ANONYMOUS_MAX_RESPONSE_BYTES", 2097152, 16384, 16777216),
    trustProxyHops: integer("ANONYMOUS_TRUST_PROXY_HOPS", 0, 0, 8),
    trustedProxyIps: (environment.ANONYMOUS_TRUSTED_PROXY_IPS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  }
}
export type AutoConfig = ReturnType<typeof readAutoConfig>
export function freeRequestReservation(config: AutoConfig) {
  return Math.ceil((config.maxInputTokens * config.maxInputPrice + config.maxCompletionTokens * config.maxCompletionPrice)
    * INFERENCE_USAGE_CONVERSION_FACTOR / 1000000 * 1.1)
}
