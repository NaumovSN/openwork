import { z } from "zod"

export const secretDefinitionInputSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[A-Z][A-Z0-9_]{0,63}$/,
        "Use an uppercase name such as WORK_TOKEN.",
      ),
    label: z.string().trim().min(1).max(120),
    helpText: z.string().trim().max(500).default(""),
    kind: z.enum(["secret", "variable"]),
    source: z.enum(["member", "organization"]),
    required: z.boolean().default(false),
  })
  .strict()
export const secretDefinitionEditSchema = secretDefinitionInputSchema
  .pick({ label: true, helpText: true, required: true })
  .extend({ expectedRevision: z.number().int().min(1) })
  .strict()
export const secretValueInputSchema = z
  .object({
    value: z.string().max(4096),
    expectedRevision: z.number().int().min(0),
  })
  .strict()
export const secretClearInputSchema = z
  .object({ expectedRevision: z.number().int().min(1) })
  .strict()
export const secretHeaderSchema = z
  .object({
    name: z.string().min(1).max(128),
    template: z.string().min(1).max(4096),
  })
  .strict()
export const secretBindingInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    headers: z.array(secretHeaderSchema).max(20),
  })
  .strict()
export const secretValueStatusSchema = secretDefinitionInputSchema.extend({
  id: z.string(),
  revision: z.number(),
  valueRevision: z.number(),
  saved: z.boolean(),
  updatedAt: z.string().nullable(),
  variableValue: z.string().optional(),
  completionCount: z.number().optional(),
})
export const secretBindingStatusSchema = z.object({
  connectionId: z.string(),
  connectionName: z.string(),
  endpoint: z.string(),
  revision: z.number(),
  headers: z.array(secretHeaderSchema),
  labels: z.array(z.string()),
  approved: z.boolean(),
  ready: z.boolean(),
  missingLabels: z.array(z.string()),
  needsAdmin: z.boolean(),
})
export const secretListSchema = z.object({
  canManage: z.boolean(),
  definitions: z.array(secretValueStatusSchema),
  bindings: z.array(secretBindingStatusSchema),
})
export type SecretDefinitionInput = z.infer<typeof secretDefinitionInputSchema>
export type SecretValueStatus = z.infer<typeof secretValueStatusSchema>
export type SecretBindingInput = z.infer<typeof secretBindingInputSchema>
export type SecretBindingStatus = z.infer<typeof secretBindingStatusSchema>
export type SecretList = z.infer<typeof secretListSchema>
