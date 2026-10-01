import { listExternalMcpTools } from "../../capability-sources/enterprise-mcp-client-adapter.js"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  secretBindingInputSchema,
  secretClearInputSchema,
  secretDefinitionEditSchema,
  secretDefinitionInputSchema,
  secretListSchema,
  secretValueInputSchema,
} from "@openwork/types/den/secrets"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  jsonValidator,
  orgMemberRoute,
  orgRoleRoute,
  paramValidator,
} from "../../middleware/index.js"
import {
  jsonResponse,
  unauthorizedSchema,
  invalidRequestSchema,
} from "../../openapi.js"
import {
  approveSecretBinding,
  createSecretDefinition,
  editSecretDefinition,
  listSecrets,
  saveSecretBinding,
  saveSecretValue,
  usableSecretConnection,
  type SecretsActor,
} from "../../secrets-store.js"
import { SecretSetupError } from "../../secrets-template.js"
import {
  ORGANIZATION_AUDIT_ACTIONS,
  recordOrganizationAuditEvent,
} from "../../audit-events.js"
import {
  ensureOrganizationAdminRole,
  type OrgRouteVariables,
} from "./shared.js"

const definitionParams = z.object({ definitionId: z.string().uuid() })
const connectionParams = z.object({
  connectionId: z.string().regex(/^emc_[0-9a-z]+$/),
})
const approveInput = z.object({ revision: z.number().int().min(1) }).strict()
const mutationSchema = z.object({ saved: z.literal(true) })
const errorSchema = z.object({ error: z.string(), message: z.string() })
function actor(c: {
  get: (key: "organizationContext") => OrgRouteVariables["organizationContext"]
}): SecretsActor {
  const context = c.get("organizationContext")
  if (!context)
    throw new SecretSetupError(
      "organization_not_found",
      "Select your workspace.",
      404,
    )
  return {
    organizationId: context.organization.id,
    memberId: context.currentMember.id,
    userId: context.currentMember.userId,
    admin: ensureOrganizationAdminRole(c, "Admin access required.").ok,
  }
}
function routeDescription(summary: string, schema: z.ZodType = mutationSchema) {
  return describeRoute({
    tags: ["Secrets and variables"],
    summary,
    responses: {
      200: jsonResponse(summary, schema),
      400: jsonResponse("Invalid input.", invalidRequestSchema),
      401: jsonResponse("Sign in required.", unauthorizedSchema),
      403: jsonResponse("Not permitted.", errorSchema),
      404: jsonResponse("Not found.", errorSchema),
      409: jsonResponse("Setup or revision changed.", errorSchema),
    },
  })
}
async function audit(
  context: SecretsActor,
  action:
    | typeof ORGANIZATION_AUDIT_ACTIONS.secretDefinitionChanged
    | typeof ORGANIZATION_AUDIT_ACTIONS.secretValueChanged
    | typeof ORGANIZATION_AUDIT_ACTIONS.secretBindingChanged,
  id: string,
  operation: string,
) {
  await recordOrganizationAuditEvent({
    organizationId: context.organizationId,
    actorUserId: context.userId,
    action,
    payload: { resourceId: id, operation },
  })
}

export function registerSecretRoutes<
  T extends { Variables: OrgRouteVariables },
>(app: Hono<T>) {
  app.use("/v1/org/secrets/*", async (c, next) => {
    try {
      await next()
    } catch (error) {
      if (error instanceof SecretSetupError)
        return c.json(
          { error: error.code, message: error.message },
          error.status,
        )
      throw error
    }
  })
  app.get(
    "/v1/org/secrets",
    routeDescription(
      "List definitions and current-member value status; never returns secrets",
      secretListSchema,
    ),
    orgMemberRoute(),
    async (c) => c.json(await listSecrets(actor(c))),
  )
  app.post(
    "/v1/org/secrets/definitions",
    routeDescription("Create an organization secret or variable requirement"),
    orgRoleRoute(["admin"]),
    jsonValidator(secretDefinitionInputSchema),
    async (c) => {
      const context = actor(c)
      const id = await createSecretDefinition(context, c.req.valid("json"))
      await audit(
        context,
        ORGANIZATION_AUDIT_ACTIONS.secretDefinitionChanged,
        id,
        "created",
      )
      return c.json({ saved: true })
    },
  )
  app.patch(
    "/v1/org/secrets/definitions/:definitionId",
    routeDescription(
      "Edit a requirement without changing its name, type, or source",
    ),
    orgRoleRoute(["admin"]),
    paramValidator(definitionParams),
    jsonValidator(secretDefinitionEditSchema),
    async (c) => {
      const context = actor(c)
      const id = c.req.valid("param").definitionId
      await editSecretDefinition(context, id, c.req.valid("json"))
      await audit(
        context,
        ORGANIZATION_AUDIT_ACTIONS.secretDefinitionChanged,
        id,
        "edited",
      )
      return c.json({ saved: true })
    },
  )
  app.put(
    "/v1/org/secrets/values/:definitionId",
    routeDescription("Set or replace your value; a secret is never returned"),
    orgMemberRoute(),
    paramValidator(definitionParams),
    jsonValidator(secretValueInputSchema),
    async (c) => {
      const context = actor(c)
      const id = c.req.valid("param").definitionId
      const body = c.req.valid("json")
      await saveSecretValue(context, id, body.expectedRevision, body.value)
      await audit(
        context,
        ORGANIZATION_AUDIT_ACTIONS.secretValueChanged,
        id,
        "replaced",
      )
      return c.json({ saved: true })
    },
  )
  app.delete(
    "/v1/org/secrets/values/:definitionId",
    routeDescription("Clear your value without reading it"),
    orgMemberRoute(),
    paramValidator(definitionParams),
    jsonValidator(secretClearInputSchema),
    async (c) => {
      const context = actor(c)
      const id = c.req.valid("param").definitionId
      await saveSecretValue(
        context,
        id,
        c.req.valid("json").expectedRevision,
        null,
      )
      await audit(
        context,
        ORGANIZATION_AUDIT_ACTIONS.secretValueChanged,
        id,
        "cleared",
      )
      return c.json({ saved: true })
    },
  )
  app.put(
    "/v1/org/secrets/connections/:connectionId",
    routeDescription(
      "Bind approved HTTP header templates to an MCP connection",
    ),
    orgRoleRoute(["admin"]),
    paramValidator(connectionParams),
    jsonValidator(secretBindingInputSchema),
    async (c) => {
      const context = actor(c)
      const id = normalizeDenTypeId(
        "externalMcpConnection",
        c.req.valid("param").connectionId,
      )
      await saveSecretBinding(context, id, c.req.valid("json"))
      await audit(
        context,
        ORGANIZATION_AUDIT_ACTIONS.secretBindingChanged,
        id,
        "bound",
      )
      return c.json({ saved: true })
    },
  )
  app.post(
    "/v1/org/secrets/connections/:connectionId/check",
    routeDescription(
      "Check the real MCP handshake with your current values",
      z.object({ toolCount: z.number().int() }),
    ),
    orgMemberRoute(),
    paramValidator(connectionParams),
    async (c) => {
      const context = actor(c)
      const id = normalizeDenTypeId(
        "externalMcpConnection",
        c.req.valid("param").connectionId,
      )
      const connection = await usableSecretConnection(context, id)
      if (connection.authType !== "none")
        return c.json(
          {
            error: "check_unavailable",
            message:
              "Check this connection from its connector page after signing in.",
          },
          400,
        )
      try {
        const tools = await listExternalMcpTools(connection, connection.url, {
          orgMembershipId: context.memberId,
        })
        return c.json({ toolCount: tools.length })
      } catch {
        return c.json(
          {
            error: "connection_check_failed",
            message:
              "Connection check failed. Review your values, destination approval, and the MCP endpoint.",
          },
          409,
        )
      }
    },
  )
  app.post(
    "/v1/org/secrets/connections/:connectionId/approve",
    routeDescription(
      "Approve the displayed credential destination for your membership",
    ),
    orgMemberRoute(),
    paramValidator(connectionParams),
    jsonValidator(approveInput),
    async (c) => {
      const context = actor(c)
      const id = normalizeDenTypeId(
        "externalMcpConnection",
        c.req.valid("param").connectionId,
      )
      await approveSecretBinding(context, id, c.req.valid("json").revision)
      await audit(
        context,
        ORGANIZATION_AUDIT_ACTIONS.secretBindingChanged,
        id,
        "approved",
      )
      return c.json({ saved: true })
    },
  )
}
