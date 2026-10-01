# OpenWork Cloud Drive

Local feature proposal · October 1, 2026 · No service provisioned or published.

## The pitch

Every OpenWork member gets a persistent place for their files and agent output.
Upload a brief, ask an agent to work from it, and find the result in the same
drive from desktop, web, Slack, or an automation. Files belong to the member's
workspace and survive the conversation or computer that produced them.

OpenWork Cloud includes a storage allowance with membership and offers paid
capacity above it, with an administrator's budget and explicit overage opt-in.
Self-hosted organizations connect their own S3-compatible storage, assign
members to storage profiles, and control folder access and limits. The everyday
experience is the same: **My drive**, **Shared with me**, and a clear usage limit.

The product advantage is continuity: **the files you give your agents and the
work they produce have a home in OpenWork**. File storage becomes useful because
it is available to the agent, under the same organization access rules.

## What the current runner gives us

This proposal references freshly fetched `different-ai/openwork:dev` at
`74232f4c1ef9f7b051a23f8374bc768d0a29b217`.

- [Headless runner #5475](https://github.com/different-ai/openwork/pull/5475),
  merged September 30, adds a Node service with durable SQLite conversations,
  idempotent sends, and MCP tools authenticated for each turn.
- [Slack integration #5022](https://github.com/different-ai/openwork/pull/5022),
  also merged September 30, connects Slack to the headless runner or OpenWork
  Web. [#5480](https://github.com/different-ai/openwork/pull/5480) extends that path.
- The runner's [README](../../../ee/apps/headless-runner/README.md) describes
  Slack as its first caller and a future automation adapter. Current cloud
  automations still use the worker runtime through
  `ee/apps/den-api/src/automations/cloud-agent-executor.ts`.
- `ee/apps/headless-runner/src/files.ts` provides **text-only, per-conversation
  scratch files**: 1 MiB/file, 10 MiB/session, 200 files. This is durable scratch,
  not a member drive, and the internal file routes use the runner service token.
- Den mints a member-and-organization MCP token per headless run, with a maximum
  60-minute lifetime; `mcp/auth.ts` checks active membership. That is a useful
  authentication seam, but today's run token has broad `mcp:read`/`mcp:write`
  scopes, not folder-specific Drive permissions.
- No general member-drive schema or S3 adapter was found in the affected
  upstream paths. Brand assets currently have a separate database-backed store.

I did not find Flue as a runner dependency in this fetched upstream revision.
The merged runner manages durability directly with `node:sqlite`. If Flue is
introduced later, Drive remains application storage behind tools; Flue's own
[database guide](https://flueframework.com/docs/guide/database/) distinguishes
runtime state from application data.

## The recommended product shape

| Decision | Initial design |
| --- | --- |
| Ownership | One private drive per **organization membership**; no automatic access across organizations |
| Sharing | Explicit folder grants to members or teams in that organization |
| Daily experience | My drive, Shared with me, attach a Drive file in chat, save agent output |
| Cloud offer | Included allowance, usage visibility, hard cap by default; optional paid capacity |
| Self hosting | Admin-configured S3 profiles, default assignment, per-member overrides and quotas |
| Agent access | Den's Drive capabilities under the caller's identity and current folder grants |
| Automation access | Current member grants intersected with the run's pinned folder and operation scope |
| Object storage | Existing S3-compatible backend; OpenWork owns permissions, metadata and accounting |
| First transfer path | Authenticated, bounded streaming through a Drive transfer service |

**Private** means hidden from other members by default. Storage operators can
access their backend, and any future administrator content-access workflow must
be separately permissioned, disclosed, and audited. Configuring a member's
storage does not silently grant that admin a browser for the member's files.

This is storage **backed by** S3-compatible infrastructure. Providing an
OpenWork-hosted S3 endpoint or issuing end-user AWS-style keys is a separate
feature. Version one uses OpenWork sign-in and Drive capabilities.

## Three experiences to pitch

1. **A member:** drop a reference file into My drive, attach it to a chat,
   and choose a Drive folder for a generated result. A persistent file reference
   works in the member's other authorized OpenWork surfaces. Sharing is an
   explicit folder action, not an automatic consequence of mentioning a file.
2. **An administrator:** choose OpenWork-managed storage or a self-hosted
   profile. For an external profile, configure endpoint, region, bucket,
   addressing mode, a server-held credential reference and an identity-based
   prefix template. Set a default allowance, upload size and member overrides;
   configure team-folder grants separately. Show last verification time and
   actionable provider errors.
3. **An automation owner:** select input and output folders when saving the
   automation. It reads only the allowed inputs and writes only the output
   folder. The run returns a durable file reference. If access is revoked or
   storage is full, the result stays visible with the exact blocked reason.

The first output path can be `Reports/automations/daily-summary.md` in My drive.
The headless runner keeps its existing scratch tools for intermediate work;
**Save to drive** is an explicit durable write. Large binaries are transferred
outside the model context, with bounded text extraction for agent reading.

## Local concept

`prototype.html` demonstrates My drive, team access, admin configuration and an
automation output. All names, files, sizes and configuration are synthetic.
There are no credentials, S3 calls, real uploads, agents, or billing changes.

The preview and the focused checks use the same in-memory decision model:

```sh
node --test docs/features/cloud-drive/model.test.mjs
node docs/features/cloud-drive/preview.mjs
```

Open the loopback URL printed by the second command. The preview binds only to
`127.0.0.1`. Stop it with Ctrl-C. Refresh resets the simulated state.

Try these concrete decisions:

- In My drive, simulate a file and see used/reserved capacity move.
- Select the team reports folder: reading is available; uploads stay visible
  and blocked by the team's read-only grant.
- In Storage settings, lower the selected member's limit to 0.25 GiB, apply
  the demo setting, then try a 40 MiB file in My drive. The quota blocks it.
- In Automation, save a sample daily summary to the permitted output folder;
  return to My drive to find it.
- Switch between managed and self-hosted storage to compare the admin controls.
  Applying settings changes this browser demonstration only.

The model checks isolation, deny rules, run-scope intersection, reservations,
idempotent completion and expiry. It is a design demonstration, not a production
implementation or evidence of database concurrency or provider compatibility.
See [local verification](verification.md) for the checks and concept screenshots.

The prototype uses native controls and a small standalone shell to keep this
local concept dependency-free. A production implementation must reuse the
app/Den primitives and tokens. It follows the intent of `DESIGN.md` P1/P3/P4,
S1/S2, C1/C5 and P11: dense file rows, quiet technical details, visible blocked
actions, and results kept in their destination. Screenshots belong to this
concept, not proof of a shipped app feature.

## Why the first transfer path matters

A signed URL is a time-limited bearer capability. AWS and R2 document that it
can be reused until expiry; AWS also documents replacement at the same key.
Checking quota before issuing a normal upload URL does not enforce a hard
byte limit or immediately revoke an outstanding upload on membership removal.
[AWS presigned URL behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html),
[R2 presigned URL behavior](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

For the first reliable version, reserve capacity transactionally, stream the
upload through an authenticated service with actual-byte enforcement, verify
the object, then finalize metadata and accounting exactly once. Quarantine
and clean failed objects without releasing their physical accounting early.
This costs transfer-service capacity, but gives a portable enforcement point.

Optimize later with a tested direct multipart protocol or an edge transfer
gateway. Do not rely on browser POST policy as a universal solution: AWS
supports size conditions in POST policies, while R2's current presigned URL
documentation says browser `POST` uploads are unsupported.
[AWS POST policy](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html),
[R2 supported methods](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

## Delivery sequence

1. **Storage foundation:** Den profile + membership drive, metadata, grants,
   quota reservations, S3 adapter and authenticated bounded transfers. Prove
   isolation and recovery against one S3 backend and one non-AWS backend.
2. **First useful journey:** upload a file, discover/read it through Den's
   existing capability system, save an agent draft, and retrieve it in the
   member UI. This can start with the headless/Slack caller without adding a VM.
3. **Governed sharing and automation:** team folders, pinned run scopes,
   save-to-drive outputs, revocation and retention behavior. Attach to the
   current automation runtime first; the new headless adapter is separate work.
4. **Commercial offer:** reconciled storage ledger, included plan allowance,
   explicit overage opt-in, admin budget, invoices and lifecycle support.
   Usage is metered from the beginning; charging starts after reconciliation
   and the commercial policy are validated.

Read [architecture.md](architecture.md) for the schema, upload protocol, folder
rules, provider compatibility, billing units and failure handling.

## Product decisions still open

- Included capacity and paid rates; the 1 GiB in the demo is illustrative.
- One chosen hosted provider and required data residency. R2 is a reasonable
  first candidate to evaluate, not a selected vendor: its published pricing
  lists storage/operation charges and no internet egress charge. Our transfer,
  scanning and support costs still exist.
  [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
- Retention after membership removal, transfer of ownership and explicit
  administrative recovery access. Private-drive ownership follows membership;
  team drives follow the organization.
- Whether paid growth is purchased as capacity tiers or metered overage.
  Recommend an included allowance plus opt-in usage, with a hard budget.
- Personal drives plus controlled team folders are the working assumption for
  this concept. Public anonymous sharing, filesystem sync, full-text indexing
  and end-user S3 keys are later independent decisions.
