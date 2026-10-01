import type { Hono, MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { authorizeDrive, deleteDrive, DriveError, listDrive, readDrive, uploadDrive, type DriveCaller } from "../../cloud-drive.js"
import { DRIVE_MAX_FILE_BYTES, drivePathSchema, drivePolicySchema } from "../../cloud-drive-config.js"
import { jsonValidator, orgMemberRoute, paramValidator } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import { updateOrganizationMetadata } from "../../organization-metadata.js"
import type { OrgRouteVariables } from "./shared.js"

const fileSchema = z.object({
  id: z.string().uuid(), path: z.string(), sizeBytes: z.number(),
  status: z.enum(["uploading", "ready", "deleting"]), createdAt: z.string(),
})
const listingSchema = z.object({
  items: z.array(fileSchema), usedBytes: z.number(), reservedBytes: z.number(),
  quotaBytes: z.number(), maxFileBytes: z.number(), allowedFolders: z.array(z.string()),
})
const fileParams = z.object({ fileId: z.string().uuid() })
const uploadSchema = z.object({
  id: z.string().uuid().describe("A fresh UUID for this upload. Reuse it only to retry the same path and bytes."),
  path: drivePathSchema,
  contentBase64: z.string().max(Math.ceil(DRIVE_MAX_FILE_BYTES / 3) * 4)
    .refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), "Use base64-encoded file bytes."),
}).strict()
const errorSchema = z.object({ error: z.string(), message: z.string() })
function description(summary: string, schema: z.ZodType) {
  return describeRoute({ tags: ["Cloud Drive"], summary,
    description: "Private files for the authenticated organization member. Requires configured S3 storage and explicit organization enablement. Limits and folder policies apply equally to browser and MCP requests.",
    responses: { 200: jsonResponse(summary, schema), 400: jsonResponse("Invalid input", errorSchema),
      403: jsonResponse("Folder or policy access denied", errorSchema), 404: jsonResponse("Drive or file unavailable", errorSchema),
      409: jsonResponse("Quota, path, or unfinished operation conflict", errorSchema), 413: jsonResponse("File too large", errorSchema),
      503: jsonResponse("Storage unavailable", errorSchema) },
  })
}

let activeTransfers = 0
/** Bound aggregate buffering as well as each individual request. */
const transferSlot: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  if (activeTransfers >= 8) return c.json({ error: "drive_busy", message: "Drive is busy. Try again shortly." }, 503)
  activeTransfers++
  try { await next() } finally { activeTransfers-- }
}

const driveBoundary: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  const payload = c.get("organizationContext")
  const user = c.get("user")
  if (!payload || !user) return c.json({ error: "drive_unavailable", message: "Cloud Drive is unavailable." }, 404)
  try {
    await authorizeDrive({ organizationId: payload.organization.id, memberId: payload.currentMember.id, userId: user.id })
    await next()
    // Hono has already finalized nested handler errors; explicitly replace
    // that response so quota and permission failures keep their proper status.
    if (c.error instanceof DriveError) c.res = c.json({ error: "drive_error", message: c.error.message }, c.error.status)
    else if (c.error) c.res = c.json({ error: "drive_unavailable", message: "Drive storage is unavailable. Try again shortly." }, 503)
  } catch (error) {
    if (error instanceof DriveError) return c.json({ error: "drive_error", message: error.message }, error.status)
    return c.json({ error: "drive_unavailable", message: "Drive storage is unavailable. Try again shortly." }, 503)
  }
}

export function registerCloudDriveRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  const caller = (payload: OrgRouteVariables["organizationContext"], user: OrgRouteVariables["user"]): DriveCaller => {
    if (!payload || !user) throw new DriveError(404, "Cloud Drive is unavailable.")
    return { organizationId: payload.organization.id, memberId: payload.currentMember.id, userId: user.id }
  }

  app.get("/v1/drive", description("List my Drive files and storage usage", listingSchema), orgMemberRoute(), driveBoundary,
    async (c) => c.json(await listDrive(caller(c.get("organizationContext"), c.get("user")))))
  app.post("/v1/drive/files", description("Upload a private Drive file", fileSchema), orgMemberRoute(), driveBoundary, transferSlot,
    bodyLimit({ maxSize: 12 * 1024 * 1024, onError: (c) => c.json({ error: "file_too_large", message: "Files must be 8 MiB or smaller." }, 413) }),
    jsonValidator(uploadSchema), async (c) => {
      const input = c.req.valid("json")
      return c.json(await uploadDrive(caller(c.get("organizationContext"), c.get("user")), { id: input.id, path: input.path, bytes: Buffer.from(input.contentBase64, "base64") }))
    })
  app.get("/v1/drive/files/:fileId", description("Read a private Drive file as base64", fileSchema.extend({ contentBase64: z.string() })),
    orgMemberRoute(), driveBoundary, transferSlot, paramValidator(fileParams), async (c) => c.json(await readDrive(caller(c.get("organizationContext"), c.get("user")), c.req.valid("param").fileId)))
  app.delete("/v1/drive/files/:fileId", description("Delete a private Drive file", z.object({ ok: z.boolean() })),
    orgMemberRoute(), driveBoundary, paramValidator(fileParams), async (c) => c.json(await deleteDrive(caller(c.get("organizationContext"), c.get("user")), c.req.valid("param").fileId)))

  const adminBoundary: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
    const identity = caller(c.get("organizationContext"), c.get("user"))
    const { role } = await authorizeDrive(identity)
    if (!role.split(",").some((value) => value === "owner" || value === "admin")) {
      return c.json({ error: "forbidden", message: "Only organization administrators can manage Drive access." }, 403)
    }
    await next()
  }
  app.get("/v1/drive/policy", description("Read organization Drive limits and folder access", drivePolicySchema),
    orgMemberRoute(), driveBoundary, adminBoundary, async (c) => {
      const { metadata } = await authorizeDrive(caller(c.get("organizationContext"), c.get("user")))
      const existing = drivePolicySchema.safeParse(metadata?.cloudDrivePolicy)
      return c.json(existing.success ? existing.data : { default: { quotaBytes: (await listDrive(caller(c.get("organizationContext"), c.get("user")))).quotaBytes, allowedFolders: ["**"] }, members: {} })
    })
  app.put("/v1/drive/policy", description("Set organization Drive limits and member folder access", drivePolicySchema),
    orgMemberRoute(), driveBoundary, adminBoundary, bodyLimit({ maxSize: 64 * 1024 }), jsonValidator(drivePolicySchema), async (c) => {
      const policy = c.req.valid("json")
      await updateOrganizationMetadata(caller(c.get("organizationContext"), c.get("user")).organizationId, (current) => ({ ...current, cloudDrivePolicy: policy }))
      return c.json(policy)
    })
}
