# ENG-76 synthetic native Slack journey

Spec: `evals/specs/native-slack-connect.e2e.test.ts`.

This is browser-representable desktop product proof (`seed.appWeb`) against
hosted Connect's real HTTP/MCP routes. It is not packaged-desktop, real Slack,
provider eligibility, app-distribution, or live-activation proof.

## Boundaries

- Real: app-web, managed OpenWork server/engine, Den authorization, native
  connection discovery, OAuth state/callback, credential storage, capability
  dispatch and scope/gate enforcement.
- Synthetic: a loopback Slack OAuth/Web API server and a deterministic model.
  The model discovers real capability names, derives thread IDs from real
  native results, and only renders content/links/limits present in tool results.
- Fixtures: two Slack user identities, four synthetic conversation categories,
  a private-message canary, a 105-message thread served in a two-message page,
  and one deliberately disallowed workspace ID. No outside identities/data.
- No OAuth client/connector is created through an admin setup API. The native
  `slack` alias must be supplied by Den from test-process-only configuration.
- The isolated Den children reject fetches to `slack.com` and its subdomains.
  Source links have synthetic Slack paths and are inspected, never followed.

## Setup contract

The world calls `seed.den` twice:

1. An isolated gate-off Den creates the scratch database, internal organization,
   two members and a separate synthetic blocked organization.
2. An isolated gate-on Den uses `provision: false` and an explicit `DATABASE_URL`
   override pointing only to the first process's `openwork_eval_*` database.
   Its otherwise unused scratch database remains owned/cleaned up by testkit.

This avoids needing an organization ID before provisioning and tests gate-off
replay against the same stored grant and issued token. No running process's
flag changes, no database credential injection, and no `.env` edits are needed.
Only the second Den child receives:

- `DEN_SLACK_ENABLED=true`
- `DEN_SLACK_ORGANIZATION_ID=<world-created internal organization ID>`
- `DEN_SLACK_WORKSPACE_ID=TSYNTHETIC`
- `DEN_SLACK_CLIENT_ID=eng-76-synthetic-client`
- `DEN_SLACK_CLIENT_SECRET=eng-76-synthetic-secret-not-a-credential`
- `DEN_SLACK_API_BASE_URL=<owned loopback origin>/api`
- `DEN_SLACK_OAUTH_AUTHORIZE_URL=<owned loopback origin>/oauth/v2/authorize`
- `DEN_SLACK_OAUTH_TOKEN_URL=<owned loopback origin>/api/oauth.v2.access`

All values are synthetic and process-scoped. Both children clear inherited
Slack bot/signing credentials. Native API search is **GET**
`/v1/capabilities/slack/search`; MCP invokes its discovered name with `query`,
not `body`. The optional `conversationTypes` query value is comma-separated.
The upstream RTS method remains POST. Threads remain GET.

The app-web children also receive `VITE_DEN_BASE_URL=enabled.ref.webUrl` and
`VITE_DEN_API_BASE_URL=enabled.ref.apiUrl`. `seed.signIn` supplies a direct API
URL for the initial handoff exchange, but browser clients subsequently
re-derive the API URL from the web base and build configuration. Because this
world does not boot den-web, there is no `/api/den` proxy on `webUrl`: the
explicit build pin keeps session restoration and native connection requests
on the owned API, including after a browser reload.

The separately minted replay tokens must return exactly `mcp:read` in the
mint response. Each Den process receives its own audience-valid token; a
wrong-audience or generic authentication rejection is not a policy witness.
A successful native search invocation proves read-only gateway authority
without changing generic POST policy. Disabled execution must specifically
return `policy_blocked`, while the existing account remains removable.

## Engine preparation

The local app-web stack boots a V1 compatibility primary even when chat is routed to V2. Supply both repository-pinned binaries through `OPENWORK_OPENCODE_BIN` and `OPENWORK_OPENCODE2_BIN`; a V2 binary on the generic `opencode` PATH cannot satisfy the V1 launcher. Prepare verified sidecars with the repository's `prepare:sidecar` script rather than relaxing startup parsing or changing the machine's OpenCode installation.

With `--engine v2`, the journey checks both public V2 runtime statuses against the build manifest, distinct process IDs, and native message history for the actual UI conversation. The CLI selection alone is not the runtime witness. Set `CHROME_BIN` to an isolated Chrome-for-Testing executable when system Chrome is absent; the harness owns its temporary browser profiles. MySQL and Redis can be supplied by `packaging/docker/docker-compose.web-local.yml`, with a loopback-only port override for the test runtime.

## Placement and outstanding proof

Do not force a lane to make this green. Run through the normal E2E CLI and
retain its placement line. The current native-provider fixture owns local
loopback sockets. Testkit has a remote transport for `mcpMock`, but no matching
native OAuth/Web API transport that co-locates this HTTP server with Den,
app-web and the inference fixture. A non-local or attached-Den run therefore
reports `needs: isolated co-located native Slack HTTP fixture; testkit has no
Daytona native-provider transport`, not a passing simulation.

Compilation is not a run verdict. The parent owns serial E2E execution and
review of screenshots/assertion evidence. Until then, this proof is
**Incomplete**. Real Slack authorization/optional-consent UI, packaged OS OAuth
handoff, actual Slack eligibility/plan behavior, and live activation remain
outside this synthetic journey.
