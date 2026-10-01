import { afterAll, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:1/not_connected"
process.env.DB_MODE = "mysql"
process.env.DEN_DB_ENCRYPTION_KEY = "synthetic-drive-route-encryption-key-123456"
process.env.BETTER_AUTH_SECRET = "synthetic-drive-route-auth-secret-123456789"
process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790"

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const userId = createDenTypeId("user")
const fileId = "00000000-0000-4000-8000-000000000001"
let enabled = false
class FixtureDriveError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
const seededResources = { from: () => seededResources, where: async () => [{ id: "synthetic-resource" }] }
mock.module("../src/db.js", () => ({ db: { select: () => seededResources } }))
const actualOrgs = await import("../src/orgs.js")
mock.module("../src/orgs.js", () => ({ ...actualOrgs, getOrganizationContextForUser: async () => ({
  organization: { id: organizationId, name: "Fixture", slug: "fixture", metadata: {} },
  currentMember: { id: memberId, userId, role: "member", isOwner: false },
  members: [], teams: [], roles: [],
}) }))
mock.module("../src/cloud-drive.js", () => ({
  DriveError: FixtureDriveError,
  authorizeDrive: async (caller: { organizationId: string; memberId: string; userId: string }) => {
    expect(caller).toEqual({ organizationId, memberId, userId })
    if (!enabled) throw new FixtureDriveError(404, "Cloud Drive is unavailable.")
    return { role: "member", metadata: {} }
  },
  listDrive: async () => ({ items: [], usedBytes: 0, reservedBytes: 0, quotaBytes: 10, maxFileBytes: 8_388_608, allowedFolders: ["**"] }),
  uploadDrive: async () => { throw new FixtureDriveError(409, "Your Drive storage limit is reached.") },
  readDrive: async () => { throw new FixtureDriveError(404, "File not found.") },
  deleteDrive: async () => { throw new Error("synthetic provider failure") },
}))
const { registerCloudDriveRoutes } = await import("../src/routes/org/cloud-drive.js")
const app = new Hono()
app.onError(() => new Response("upstream error", { status: 500 }))
app.use("*", async (c, next) => {
  c.set("user", { id: userId })
  c.set("session", { id: "synthetic-session", activeOrganizationId: organizationId })
  c.set("activeOrganizationId", organizationId)
  await next()
})
registerCloudDriveRoutes(app)
afterAll(() => mock.restore())

test("Drive registers its authentication middleware and returns the disabled status", async () => {
  enabled = false
  const response = await app.request("/v1/drive")
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ message: "Cloud Drive is unavailable." })
})

test("quota, missing-file and provider errors retain their public HTTP status", async () => {
  enabled = true
  const listing = await app.request("/v1/drive")
  expect(listing.status).toBe(200)
  expect(await listing.json()).toMatchObject({ items: [], quotaBytes: 10 })
  const missing = await app.request(`/v1/drive/files/${fileId}`)
  expect(missing.status).toBe(404)
  const upload = await app.request("/v1/drive/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: fileId, path: "file.txt", contentBase64: "YQ==" }) })
  expect(upload.status).toBe(409)
  const deletion = await app.request(`/v1/drive/files/${fileId}`, { method: "DELETE" })
  expect(deletion.status).toBe(503)
  expect(await deletion.text()).not.toContain("synthetic provider failure")
  const policy = await app.request("/v1/drive/policy")
  expect(policy.status).toBe(403)
})


test("the maximum file reaches admission and an oversized body is rejected before storage", async () => {
  enabled = true
  const post = (size: number) => app.request("/v1/drive/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: fileId, path: "large.bin", contentBase64: Buffer.alloc(size).toString("base64") }) })
  expect((await post(8 * 1024 * 1024)).status).toBe(409)
  expect((await post(9 * 1024 * 1024)).status).toBe(413)
})
