/** A token value, never a header, scheme, URL, or expression. */
export function validMemberApiKey(value: string): boolean {
  return value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value)
}

export function memberApiKeyAuthorization(value: string, scheme: "bearer" | "token" = "bearer"): string {
  if (!validMemberApiKey(value)) throw new Error("A valid personal API key is required.")
  return `${scheme === "token" ? "Token" : "Bearer"} ${value}`
}
