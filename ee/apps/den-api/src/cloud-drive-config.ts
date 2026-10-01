import { z } from "zod"
import { normalizeOrganizationCapabilities } from "./organization-capabilities.js"

export const DRIVE_MAX_FILE_BYTES = 8 * 1024 * 1024
export const drivePathSchema = z.string().min(1).max(500).refine((path) =>
  path === path.normalize("NFC") && !/[\\\u0000-\u001f\u007f]/u.test(path)
  && path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
{ message: "Use a relative file path without empty segments or traversal." })

const storageSchema = z.object({
  endpoint: z.url().refine((value) => {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  }),
  region: z.string().min(1),
  bucket: z.string().min(1).max(63),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().optional(),
  prefix: drivePathSchema.default("openwork-drive"),
  forcePathStyle: z.boolean(),
  quotaBytes: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
})
export type DriveStorageConfig = z.infer<typeof storageSchema>

/** Optional and fail closed. No provider credential is returned to clients. */
export function readDriveStorageConfig(values: Record<string, string | undefined>): DriveStorageConfig | null {
  const parsed = storageSchema.safeParse({
    endpoint: values.DEN_DRIVE_S3_ENDPOINT,
    region: values.DEN_DRIVE_S3_REGION,
    bucket: values.DEN_DRIVE_S3_BUCKET,
    accessKeyId: values.DEN_DRIVE_S3_ACCESS_KEY_ID,
    secretAccessKey: values.DEN_DRIVE_S3_SECRET_ACCESS_KEY,
    sessionToken: values.DEN_DRIVE_S3_SESSION_TOKEN,
    prefix: values.DEN_DRIVE_S3_PREFIX,
    forcePathStyle: values.DEN_DRIVE_S3_FORCE_PATH_STYLE === "true",
    quotaBytes: values.DEN_DRIVE_QUOTA_BYTES ?? 1024 * 1024 * 1024,
  })
  return parsed.success ? parsed.data : null
}

export function cloudDriveEnabled(metadata: Parameters<typeof normalizeOrganizationCapabilities>[0], configured: boolean) {
  return configured && normalizeOrganizationCapabilities(metadata).cloudDrive
}

const folderPatternSchema = z.string().max(500).refine((value) =>
  value === "**" || (value.endsWith("/**") && drivePathSchema.safeParse(value.slice(0, -3)).success),
{ message: "Use ** for all folders or a relative folder followed by /**." })
export const driveMemberPolicySchema = z.object({
  quotaBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  allowedFolders: z.array(folderPatternSchema).min(1).max(32),
}).strict()
export const drivePolicySchema = z.object({
  default: driveMemberPolicySchema,
  members: z.record(z.string().regex(/^om_[a-z0-9]+$/), driveMemberPolicySchema).default({}),
}).strict()
export type DriveMemberPolicy = z.infer<typeof driveMemberPolicySchema>

export function driveMemberPolicy(metadata: Record<string, unknown> | null, memberId: string, quotaCeiling: number): DriveMemberPolicy {
  if (metadata?.cloudDrivePolicy !== undefined) {
    const parsed = drivePolicySchema.safeParse(metadata.cloudDrivePolicy)
    // Invalid stored policy never expands access to all folders.
    if (!parsed.success) return { quotaBytes: 0, allowedFolders: [] }
    const policy = parsed.data.members[memberId] ?? parsed.data.default
    return { ...policy, quotaBytes: Math.min(policy.quotaBytes, quotaCeiling) }
  }
  return { quotaBytes: quotaCeiling, allowedFolders: ["**"] }
}

export function drivePathAllowed(path: string, policy: DriveMemberPolicy) {
  return drivePathSchema.safeParse(path).success && policy.allowedFolders.some((pattern) =>
    pattern === "**" || path.startsWith(`${pattern.slice(0, -3)}/`))
}
