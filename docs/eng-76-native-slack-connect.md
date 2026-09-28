# ENG-76: Native Slack Connect design interview

Status: **Approved for implementation.** The user confirmed the design and requested implementation. App creation or distribution, live credential changes, flag enablement, and outreach still require separate approval.

## Working-integration milestone

Prove a member can use OpenWork desktop with hosted OpenWork Connect to authorize Slack, find discussions, read thread context, and receive an answer with source links. Marketplace submission is not required for this milestone. The live proof uses synthetic conversations in an OpenWork-owned validation workspace, not ordinary business conversations or external customers' workspaces.

## Agreed product scope

- Use Slack's Web API, not Slack's upstream MCP server. Reuse normal OpenWork Connect capability interfaces rather than introducing a desktop-only integration.
- OpenWork supplies the Slack app for hosted Connect. Members do not create apps, configure app permissions, or supply client credentials. Workspace administrator approval and individual authorization may still be required.
- Read-only search and thread context across public channels, private channels, one-to-one DMs, and group DMs, bounded by the connecting member's Slack permissions.
- One connected Slack workspace per member for the initial release.
- Live lookup only: no background sync, bulk history import, or separate Slack archive.
- Bounded reads with clear incomplete-context indicators and source links. A thread excerpt must not be represented as a complete thread; users can request more context.
- Partial consent remains usable. Public-only access is not a broken connection; private/DM categories are queried only when authorized, and unavailable categories must not be reported as having no results.
- No message sending, replies, reactions, or file-content search in this milestone.
- The first end-to-end acceptance surface is OpenWork desktop using hosted Connect. Self-hosted platform-app setup and additional client-specific acceptance journeys are outside this milestone.
- A minimal in-Slack connection/help surface is allowed if needed to satisfy RTS app guidance, such as an App Home explaining the integration and linking to connection management. No chatbot or conversation-message posting is included; the precise provider requirement must be verified rather than assuming a decorative page satisfies it.
- For synthetic-data-only acceptance, normal OpenWork session persistence is acceptable. Do not build a new retention system for this milestone, add a Slack archive or content logging, or promise zero retention. Ordinary internal or external real-data use remains separately gated.

## Existing integration compatibility

The original issue calls for preserving the enterprise BYO-app path. The proposed native connector must not silently migrate or delete existing Slack MCP/BYO connections, change their credentials, or remove the eligibility warnings applicable to that distinct path. Any change to those existing connections requires a separate decision; their existence does not establish permission for new external installations.

## Availability boundary

The code can support a later external rollout, but initial availability is fail-closed and restricted to OpenWork's internal organization and the designated Slack validation workspace. Checking only the OpenWork organization is insufficient because an internal tester could otherwise authorize an external Slack workspace.

A server-enforced gate controls availability, not provider authorization. External organizations and workspaces remain disabled until their distribution authorization and search eligibility are established and external enablement is explicitly approved. Everyday internal use of real conversations also requires a separate enablement decision after retention and model-processing behavior are addressed.

The current general Connect switch is default-on and is not a sufficient native Slack rollout barrier. Implementation uses the default-off deployment flag `DEN_SLACK_ENABLED` with explicit `DEN_SLACK_ORGANIZATION_ID` and `DEN_SLACK_WORKSPACE_ID` bindings. OAuth and capability routes also respect the general organization Connect policy. No customer-admin setting can configure the platform app or create additional native Slack account slots; existing external MCP/BYO settings remain separate.

See [ADR 0001](adr/0001-internal-first-native-slack-rollout.md).

## Acceptance proof

The agreed live journey is:

1. Authorize without member-side developer setup in OpenWork desktop using hosted Connect.
2. Search for a known synthetic discussion and retrieve bounded thread context.
3. Produce a useful answer with links to the Slack sources and an explicit indication if context is incomplete.
4. Demonstrate public/private-channel, one-to-one-DM, and group-DM access using synthetic conversations.
5. Use two internal test members to prove one member cannot retrieve another member's inaccessible private conversations.
6. Demonstrate usable partial consent without claiming unsearched categories had no results.

The rollout boundary also needs negative verification: blocked organizations/workspaces must not connect or execute by bypassing the UI, and disabling availability must prevent later use of already known capability names. These checks do not require or authorize installing the app into an external workspace.

No live proof, app creation, fixture provisioning, or test execution has occurred during this interview.

## Implementation and activation facts

- Slack's modern Real-time Search API documents internal-app eligibility and outside-Slack user-token queries. This does not clear external unlisted distribution. Legacy search is not an established permitted fallback.
- RTS general guidance also asks for an in-Slack experience but does not define the minimum internal-app surface. OpenWork-side acceptance and app-level provider requirements are distinct.
- OpenWork's normal session history retains tool output. Saved Workflows can retain result snapshots; disconnecting an account does not erase existing transcripts or snapshots. No end-to-end per-provider no-persistence switch was found.
- An arbitrary external client controls its own storage after receiving capability results. A hosted connector cannot promise to erase or prevent all client-side copies.
- Internal own-company use differs from external commercial distribution, but neither a read-only interface nor live lookup alone establishes permission for every retention or model-processing arrangement.

## Provider setup and activation prerequisites

These are checks to complete before live activation, not permission granted by this design:

- Verify the chosen direct search API and internal app setup meet Slack's documented eligibility, scope, consent, and app-level experience requirements. Modern RTS is the documented internal-app candidate; do not silently substitute legacy search to bypass unresolved requirements.
- Determine the precise minimal in-Slack connection/help surface needed. If the requirement cannot be established, record it as an activation blocker rather than claim the app is compliant.
- Confirm the OpenWork organization and owned validation workspace, synthetic fixtures, and two test members without putting private identities or live credentials into public documentation or fixtures.
- Obtain separate approval before creating an app, provisioning live fixtures, configuring credentials, or enabling the gate. No external installations or outreach are authorized.
- Keep routine real-data use and external availability disabled. Review model processing, result retention, and provider authorization before either is enabled.

## Implementation authorization and verification seams

The user reviewed the documents and approved implementation. App creation, live credential changes, flag enablement, external rollout, and outreach remain separate approval-gated actions.

Tests exercise the approved public seams: member-facing connection discovery and consent state; OAuth start/callback/status/disconnect; native Connect search/thread execution including direct-route and retained-capability denial; the desktop-app connection journey with synthetic providers; and the optional signed Slack connection/help surface. Provider HTTP, credential storage, and identity fixtures may be controlled in tests; private implementation details are not the acceptance contract.

## References

- [Domain glossary](../CONTEXT.md)
- [Slack feasibility and internal-preview research](research/eng-76-slack-web-api-feasibility.md)
- [Existing external MCP OAuth behavior](external-mcp-oauth.md) — the existing Slack MCP/BYO path is distinct from this proposed native connector.
