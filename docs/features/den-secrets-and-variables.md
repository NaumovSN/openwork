# Den secrets and variables for MCP connections

Status: design draft. This document scopes the feature; it does not add runtime
behavior, migrations, or a secret-management service.

## Outcome

An organization administrator configures an MCP connection once using named
references. Members supply their own credentials in Den, and Den substitutes
the calling member's values only when making an authorized outbound request.
An administrator can also supply organization values that apply to all members
who already have access to the bound connection.

Add **Secrets and variables** to Den's menu. Follow Vercel's compact management
table, separate readable configuration from write-only secrets, and provide
replacement without revealing the saved secret. Vercel currently calls these
types Config and Secret and also supports shared values linked to projects.
OpenWork calls the readable type Variable and links values to connections.
See [Vercel secret types](https://vercel.com/docs/environment-variables/sensitive-environment-variables)
and [shared values](https://vercel.com/docs/environment-variables/shared-environment-variables).

Example administrator configuration:

```text
Name: WORK_TOKEN
Label: Work account token
Type: Secret
Value source: Each member
Required: Yes
Used by: Work service connection

Authorization: Bearer {!WORK_TOKEN}
X-Workspace: {!WORKSPACE_ID}
```

`WORKSPACE_ID` can be an organization variable supplied by an administrator.
Two members using the same connection send different `WORK_TOKEN` values and
the same `WORKSPACE_ID`. The agent sees connection readiness and references;
it never receives the resolved credential.

## Recommended first version

| Decision | Scope |
| --- | --- |
| Management surface | Den, organization-scoped Secrets and variables page |
| Types | Secret (write-only) and Variable (readable by its value owner) |
| Value sources | Each member, or Organization |
| User requirements | Admin-defined templates, optionally required for every active member |
| Consumption | Den-managed external HTTP MCP connections only |
| Syntax | `{!NAME}` in supported string fields |
| Initial destinations | Static bearer token, approved request-header values, and organization-managed OAuth client fields |
| Resolution | Server-side, with verified organization and member identity, immediately before use |
| Excluded destinations | Prompts, skills, plugin text, tool arguments/results, URLs, local environment variables, stdio MCPs, and native-provider connectors |

This is a connection credential feature. General string interpolation, shell
expansion, a password vault, `.env` import/export, environment/branch matrices,
external vault synchronization, and automated provider-side rotation are
follow-ups.

## Definitions, values, and permissions

A definition belongs to one organization and contains an immutable name,
editable label and help text, type, value source, required flag, and revision.
Names use `[A-Z][A-Z0-9_]{0,63}` and are unique across both types and value
sources in that organization. Labels can change without breaking references.

A definition with **Each member** is the administrator's template. It has one
independent value per active organization membership, not per global user.
New members inherit the definition and start with no value. No member can
rename it, change its requirement, or fill another member's value. Required
definitions appear for every active member, even before connection assignment.

An **Organization** definition has one administrator-supplied value. Members
cannot list or edit organization definitions or their values. A member's
connection screen can report that shared setup needs an administrator without
exposing the shared definition. Organization values are usable by all members
granted the bound connection; a reference does not grant connection access.

| Action | Owner/admin | Ordinary member | Den request runtime |
| --- | --- | --- | --- |
| Create/edit definitions and requirements | Yes | No | No |
| Bind a definition to an MCP connection | Yes | No | No |
| View member completion status | Metadata only | Own status | Authorized caller only |
| Save/replace/clear a member value | Own membership only | Own membership only | No |
| Save/replace/clear an organization value | Yes | No | No |
| Read a saved secret through management APIs | Never | Never | No management read API |
| Read a saved variable | Organization values and own member values | Own member values | Only for bound requests |
| Resolve a secret for a bound request | No general-purpose endpoint | No general-purpose endpoint | Yes, after access checks |

Keep the definition's type and source immutable in the first version. Do not
convert a Secret into a readable Variable or move personal values into shared
storage. Create a new definition and explicitly rebind connections instead.
Prevent reuse of a retired name from silently reconnecting old references.

## Den experience

Members see compact rows: label, Required when applicable, Not provided / Saved
or Action needed, updated time, and Add value or Replace value. Secrets have no
reveal or copy action and no prefilled edit field. A constant Saved state must
not expose value length, suffix, fingerprint, or part of the value. Variables
can show their current value to the value owner.

Admins use the same page with a **My values** view plus management views for
**Member requirements** and **Organization values**. Definition creation asks
for name, label, type, source, help text, and requirement. Member requirements
show completion counts and authorized member status, never submitted secrets.
All value entry uses the existing accessible Den form and dialog components.

The connection editor offers **Use a secret or variable** in supported fields.
Selection inserts a reference; typed references remain supported. Show which
definitions the connection uses without a resolved preview. Explain who
supplies a value before saving the connection.

A missing required value marks the affected connection **Action needed** with
**Add value**. Den, account settings, and unrelated connections remain usable.
Any referenced value must be present to send its request, even if the definition
is optional. Required means the member owes a value; it is not a bypass for
connection grants or a reason to block the whole organization.

Use the normal menu/search routing and organization switcher. Show loading,
empty, failure, locked, and saved states using the same layout. UI implementation
follows [DESIGN.md](../../DESIGN.md): P3, P5, P6, S2, C1, C5, and C6. There is
no new UI in this design PR; screenshots belong to the implementation proof.

## Template contract

- Recognize only exact `{!NAME}` references. Strings may contain several
  references and literal prefixes/suffixes, such as `Bearer {!WORK_TOKEN}`.
- Resolve the name to a definition when the administrator saves a connection;
  persist stable definition IDs and a binding revision alongside display text.
  Never resolve a different definition merely because its name matches later.
- Perform one substitution pass. Treat inserted values as opaque text, even
  when they contain `{!OTHER_NAME}`. No evaluation, nesting, defaults, functions,
  transformations, escaping language, or filesystem/environment lookup.
- Validate unknown names, malformed `{!` syntax, and unsupported placements
  before saving. Treat template markers in submitted values as ordinary data.
- Use the definition's source exactly. Never fall back from a missing member
  secret to an organization value or another member's credential.
- Preserve submitted bytes; do not trim a secret. Reject empty secret values,
  apply a 4 KiB UTF-8 input limit, and use an explicit Clear action for removal.
  Enforce per-field limits after expansion and reject invalid header characters
  such as CR, LF, and NUL before network I/O. An empty readable variable can be
  stored, but a field requiring nonempty content rejects the expanded result.
- Return a structured, sanitized setup error when a value is missing, removed,
  unauthorized, or invalid. Never send unresolved placeholders or partial
  credentials. No request occurs if any required expansion fails.

## Supported request fields and OAuth boundary

**Static credentials:** support a reference in the existing API-key/bearer-token
field and add explicit header-value templates for integrations using headers
such as `X-API-Key` or `X-Workspace`. Header names are literal and validated;
allow application/authentication headers while reserving transport/protocol
headers such as Host, Cookie, Content-Length, Connection, MCP session/version
headers, and forwarding headers. No duplicate headers differing only by case.
Authorization has one source: static bearer authentication or an explicit
non-OAuth header template, never both. Basic-auth strings can be supplied as
complete pre-encoded secrets; generating or transforming them is outside v1.
Connections with Each member references require per-member credential mode;
reject a shared-mode binding rather than caching one member's authenticated
session for the whole organization. Their static values stay in the new value
store, separate from OAuth connected-account tokens. Connection readiness and
catalog discovery must use that same member-aware resolution path.

**OAuth:** allow organization Variable references in the pre-registered client
ID and organization Secret references in its client secret. Resolve these
through Den's existing OAuth persistence/client layer. Client IDs are public
protocol fields and appear in browser authorization URLs, so a Secret reference
is rejected there. Client secrets are sent only by the existing server-side
`client_secret_basic` / `client_secret_post` token-exchange and refresh path.
Persist references in configuration, not a second copied plaintext credential.

The existing per-member authorization still owns each member's access/refresh
tokens. Templating does not replace PKCE, state, issuer/resource validation,
scope policy, consent, registration discovery, or token handling. Do not support
username/password OAuth grants, templated access/refresh-token fields, arbitrary
OAuth request bodies, or overriding an OAuth-managed Authorization header.
See the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
for resource and token handling requirements.

Member-supplied OAuth client IDs/secrets are deferred: the current OAuth client
is organization-scoped, and changing its identity for every caller would require
member-scoped registration, pending-state, refresh, and cache persistence. Member
templates in v1 supply static MCP credentials and additional approved headers.

## Request authorization and destination binding

1. Derive the organization/member from the authenticated Den principal. Check
   active membership, connection/plugin access, tool policy, and the operation's
   current permission before fetching values. Caller-supplied IDs do not select
   another member's credentials.
2. Check the connection's exact definition bindings and the member's approved
   binding revision. Each template value can be consumed only by its explicitly
   bound connection and approved destination/field, not every MCP in the org.
3. Read only those values into the server request context. Use a consistent
   committed value/definition/binding revision for the operation and resolve
   at the final outbound boundary; no agent/client transport receives them.
4. Apply expansion after destination validation and before the particular
   request is sent. Keep the existing guarded fetch and SSRF protections.
   Secret-bearing requests require HTTPS; local HTTP proof uses synthetic
   fixtures behind the existing development/test policy.
5. Inject MCP headers only on the bound MCP resource requests, including its
   authenticated handshake, catalog, and tool/resource operations. Do not send
   them to OAuth metadata discovery, client registration, token endpoints,
   unrelated diagnostics, or redirect destinations. OAuth client secrets have
   a separate binding to the validated token endpoint. Reject redirects for
   requests containing injected secrets in v1, rather than trusting forwarding
   behavior.

Recheck access and bound value/configuration revisions before each outbound
attempt, including retries and requests within an existing MCP session. Requests
admitted after a committed replacement/clear must observe that change; a request
already admitted or dispatched can be in flight and cannot be recalled.

Saving a personal value does not approve all future use of it. Before first use,
show the member the connection, credential label, destination, and purpose, then
record approval of that binding revision. An administrator adding a destination,
changing a URL/issuer/token endpoint, changing a sensitive field mapping, or
expanding the use of a personal secret makes the affected bindings need approval
again. Label changes alone do not. Discovery that changes a previously approved
token endpoint fails closed until reviewed. Shared organization bindings use an
administrator's approval rather than a new member approval on every request.

**Security limit:** write-only means OpenWork never returns the saved secret
through its management UI, APIs, SDK, or MCP tools. Den must decrypt it to send
it, and the approved remote service receives it. A malicious destination can
retain or encode/echo it; no application can guarantee that recipient will not
reveal it. This is not protection against a compromised Den runtime, a credential
theft before entry, or a malicious provider. Destination approval and restricted
egress are essential, including when an administrator controls configuration.

## Storage, API, and lifecycle

Add definition, value, and connection-binding records. A value is either keyed
by `(organization, definition, member)` or by `(organization, definition)` for
an organization source. Use explicit uniqueness and source checks; nullable
member IDs must not accidentally allow duplicate shared rows. Store binding
approvals separately per active membership and configuration revision.

Reuse Den's authenticated encrypted-column mechanism and its externally supplied
database key for secret values. Do not hash secrets for storage: outbound use
requires reversible encryption. Variables can use the same storage mechanism
but have a separate explicitly readable API contract. An unavailable key blocks
secret writes/use; there is no plaintext fallback. Deployment/key custody,
encrypted backups, key rotation, and backup restore remain the operator's
responsibility. This feature does not add a KMS or claim zero-knowledge storage.

Define separate DTOs for definitions, value status, write requests, and readable
variables. Secret writes return metadata only; no list/get/export/resolve route
returns the secret, ciphertext, hash, suffix, or stored-value length. Reject
attempts to read secrets even for owners/admins. Keep plaintext value reads
inside a narrow server-only resolver, outside management route serialization.

Proposed route families, under Den's existing organization/member authorization:

- Admin definition create/update/retire and member completion-status reads.
- Current-member value list/status, set/replace, clear, and readable-variable
  reads; no member-selector parameter on member write routes.
- Admin organization-value status, set/replace, clear, and variable reads.
- Connection binding management and current-member binding approval.

Use optimistic revisions on edits to prevent stale forms from overwriting newer
values or definitions. A successful replace changes the version atomically;
new requests observe it without a redeploy. Do not retain readable secret
history. A request already dispatched cannot be recalled. Avoid long-lived
plaintext/expanded-client caches; any request/session cache key includes org,
member, connection, binding revision, and value revisions, with bounded lifetime
and invalidation on mutation, membership removal, or access revocation.

Replacing an OAuth client secret applies to later token exchanges/refreshes,
following the existing OAuth lifecycle. Changing the client ID invalidates the
old identity's grants and pending flows; an in-flight callback cannot resurrect
them. Clearing a referenced client secret blocks subsequent exchanges/refreshes.
Clearing a general value or removing access stops new dependent outbound use.
None of these actions promises to revoke an already issued provider token:
provider-side revocation/rotation is a separate action.

Before retiring a definition, show its dependent connections and block deletion
while live bindings remain. Clear is explicit; omitted write fields preserve
values. Removing a membership deletes/deactivates its personal values and
approvals; rejoining never inherits old credentials. Disabling requirements
does not silently clear values or approve new destinations.

## Diagnostics and audit

Never log write bodies, decrypted values, expanded headers, OAuth client secrets,
or plaintext-bearing exceptions. Redact each complete templated header value,
including custom names, rather than relying on a list of common auth headers.
Extend connection inspection, errors, traces, and responses that can echo a
credential to remove raw values and standard transmitted encodings for all
secret lengths. Disable sensitive inspection when safe redaction cannot be
established. Redaction reduces accidental echo; it cannot make an untrusted
remote service safe or detect arbitrary secret transformations.

Record definition changes, value set/replace/clear, binding approvals/changes,
uses/denials, and revocation with organization, actor, definition/connection
IDs, revision, time, and outcome only. Give admins completion metadata, not
payloads. Use existing Den audit infrastructure with bounded event volume and
access controls. [OWASP secret management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
supports least privilege, lifecycle audit, rotation/revocation, minimizing
plaintext exposure, and excluding secrets from logs.

## Existing integration points

These are current components to extend, not proposed parallel systems:

- [Credential schema](../../ee/packages/den-db/src/schema/sharables/capability-credentials.ts)
  already distinguishes organization-shared connections, organization OAuth
  clients, and membership-owned connected accounts.
- [Encrypted columns](../../ee/packages/den-db/src/columns.ts) provide authenticated
  encryption; definition/value queries need explicit metadata projections so
  listing requirements does not decrypt every secret.
- [Connection routes](../../ee/apps/den-api/src/routes/org/mcp-connections.ts)
  already accept a bearer key and pre-registered client credentials and omit
  stored secrets from reads. Add reference/binding inputs without changing
  existing literal configurations.
- [Enterprise client adapter](../../ee/apps/den-api/src/capability-sources/enterprise-mcp-client-adapter.ts)
  owns the outbound client and guarded fetch. Extend its operation/member
  context and the transport's header contract rather than interpolating in chat.
- [OAuth persistence](../../ee/apps/den-api/src/capability-sources/enterprise-mcp-oauth-persistence.ts)
  and [identity rotation](../../ee/apps/den-api/src/capability-sources/oauth-client-rotation.ts)
  own client/token persistence and identity-change invalidation.
- [Tool inspection](../../ee/apps/den-api/src/capability-sources/external-mcp-tool-inspection.ts)
  and [diagnostics](../../ee/apps/den-api/src/capability-sources/external-mcp-diagnostics.ts)
  must understand all injected sensitive headers before templating is enabled.
- [Den navigation](../../ee/apps/den-web/app/(den)/dashboard/_lib/dashboard-navigation.ts)
  supplies role-aware menu/search entries. Reuse its organization routing and
  existing accessible connection editor/forms.

Existing literal credentials keep working. Do not silently migrate them into
named definitions, parse legacy literal tokens as templates, change connection
grants, or grant plugins an independent secret-read capability. Enable reference
mode explicitly; a literal token containing template-looking text stays literal.

## Delivery slices and acceptance proof

1. **Definitions and write-only values:** schema/migrations, authorization,
   metadata-only DTOs, lifecycle audit, and Den member/admin flows.
2. **Static MCP templates:** parsed references, connection bindings/approval,
   member-aware request resolution, guarded egress, diagnostics redaction,
   readiness, and cache invalidation. Value entry alone is not a usable release.
3. **Organization OAuth references:** integrate pre-registered client fields
   with existing persistence, exchange/refresh, and identity invalidation.
   No custom grant implementation or member-scoped client registration.

Keep each implementation PR focused and follow the live Den contract-generation
requirements when routes/types/schema change. Keep this design PR documentation
only. Before enabling the feature, prove the following with synthetic values:

| Proof | Observable result |
| --- | --- |
| Admin defines a required personal secret | Existing/new members see its label and Not provided; cannot change the definition |
| Two members submit different values | The same approved MCP endpoint receives the calling member's credential only |
| Admin supplies a shared value | Authorized members use it; cannot enumerate/read/edit the organization value |
| Owner/admin/member attempts secret readback | List, get, write response, SDK, and MCP surfaces return metadata only |
| Missing/cleared/unknown reference | No outbound request; the affected connection reports the action needed |
| Literal and multi-reference strings | One-pass expansion preserves bytes; inserted template syntax is not evaluated |
| Invalid expanded header | CR/LF/NUL, duplicate/reserved header, and size violations send no request |
| Destination or binding changes | Prior personal approval is insufficient; secrets do not reach a new endpoint |
| OAuth metadata/registration/token and redirect traffic | MCP headers are absent; OAuth secrets reach only the approved token endpoint |
| Cross-org/cross-member/revoked caller | Resolution fails; no secret or outbound request escapes the tenant/member boundary |
| Replace/clear/race and stale form | New committed requests use the current version; stale writes fail; revoked state stays revoked |
| OAuth client identity/secret update | Exchange/refresh uses current references; old client identity/pending callback cannot restore a grant |
| Inspection/logging/provider echo | Raw and standard encoded synthetic secrets are absent from returned diagnostics and stored telemetry |
| Existing literal connection | Behavior is unchanged, including a literal token with template-looking characters |

Extend the relevant Den connection/member journey with admin, member, second
member, and denied-access steps. Include before/after screenshots in the
implementation spec and focused runtime assertions at the credential boundary.
CI owns PR evidence publication. This design document is not runtime proof.

## Deferred product decisions

Member-scoped OAuth client registration, delegated secret managers, automated
provider rotation, expiration policies, external vaults/KMS, environment tiers,
and templates in other surfaces remain separate proposals. The first version
uses existing org owner/admin roles, all-member requirements, and explicit
connection bindings; it introduces no new organization role or ambient secret
access for agents.
