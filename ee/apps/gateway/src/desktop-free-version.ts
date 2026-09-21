import type { DesktopFreeVersionError } from "@openwork/types/desktop-free-access"

export const DESKTOP_FREE_RELEASE_URL = "https://api.github.com/repos/different-ai/openwork/releases/latest"
const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
const semver = new RegExp(`^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`)
function parseVersion(value: string) {
  if (value.length > 128) return null
  const match = semver.exec(value)
  if (!match || match[0] !== value) return null
  const core = match.slice(1, 4).map(Number)
  if (core.some((part) => !Number.isSafeInteger(part)) || core.every((part) => part === 0)) return null
  return { core, prerelease: match[4] }
}
export function desktopFreeVersionError(currentVersion: string, minimumVersion: string | null): DesktopFreeVersionError | null {
  const minimum = minimumVersion === null ? null : parseVersion(minimumVersion)
  if (!minimum || minimum.prerelease) return { code: "desktop_version_unavailable", currentVersion, minimumVersion: null,
    message: "The supported desktop version cannot be verified. Auto is temporarily unavailable." }
  const current = parseVersion(currentVersion)
  let comparison = 0
  if (current) {
    for (let index = 0; index < 3; index++) {
      comparison = Math.sign(current.core[index] - minimum.core[index])
      if (comparison !== 0) break
    }
    if (comparison === 0 && current.prerelease) comparison = -1
  }
  if (!current || comparison < 0) return { code: "desktop_update_required", currentVersion, minimumVersion,
    message: `Update OpenWork Desktop to ${minimumVersion} or newer to use Auto.` }
  return null
}

export function createDesktopFreeVersionSource(options: { url: string; fetch?: typeof fetch; now?: () => number }) {
  const now = options.now ?? Date.now
  const fetcher = options.fetch ?? fetch
  let cached: { version: string; expiresAt: number } | null = null
  let pending: Promise<string | null> | null = null
  let retryAt = 0
  async function refresh() {
    const startedAt = now()
    try {
      const url = new URL(options.url)
      if (url.protocol !== "https:" || url.username || url.password || url.hash) return null
      const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(3000),
        headers: { accept: "application/json", "user-agent": "OpenWork-Desktop-Free-Access" } })
      if (!response.ok || response.redirected || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        void response.body?.cancel().catch(() => undefined)
        return null
      }
      const reader = response.body?.getReader()
      if (!reader) return null
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 262144) { void reader.cancel().catch(() => undefined); return null }
        chunks.push(chunk.value)
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null
      let version: string
      if (url.href === DESKTOP_FREE_RELEASE_URL || "tag_name" in value || "draft" in value || "prerelease" in value) {
        if (!("tag_name" in value) || typeof value.tag_name !== "string" || !("draft" in value) || value.draft !== false
          || !("prerelease" in value) || value.prerelease !== false || !("published_at" in value)
          || typeof value.published_at !== "string" || !Number.isFinite(Date.parse(value.published_at))) return null
        version = value.tag_name.replace(/^v/, "")
      } else {
        if (!("latestAppVersion" in value) || typeof value.latestAppVersion !== "string") return null
        version = value.latestAppVersion
      }
      const parsed = parseVersion(version)
      if (!parsed || parsed.prerelease) return null
      cached = { version, expiresAt: startedAt + 300000 }
      return version
    } catch { return null }
    finally { retryAt = now() + 30000 }
  }
  return async () => {
    if (cached && cached.expiresAt > now()) return cached.version
    if (pending) return pending
    if (retryAt > now()) return null
    pending = refresh().finally(() => { pending = null })
    return pending
  }
}
