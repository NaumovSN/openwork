# Optional Cloud Drive — draft implementation

Cloud Drive is optional on hosted and self-hosted Den. Configure a private S3
bucket on the server, then enable **Cloud Drive** on an organization's row in
`/admin`. Both conditions are required. Without either, My Drive is absent from
navigation and search, the page redirects to the dashboard, MCP discovery hides
Drive operations, and file requests fail closed. Public organization creation
cannot opt itself into the platform flag.

## Server setup

Apply the Den database migration before enabling any organization. Set these
environment variables on **den-api** through the deployment's secret manager:

| Variable | Purpose |
| --- | --- |
| `DEN_DRIVE_S3_ENDPOINT` | HTTPS S3-compatible service endpoint; loopback HTTP is supported for local fixtures |
| `DEN_DRIVE_S3_REGION` | Signing region; use the value required by your provider |
| `DEN_DRIVE_S3_BUCKET` | Existing private bucket |
| `DEN_DRIVE_S3_ACCESS_KEY_ID` | Server-only access key |
| `DEN_DRIVE_S3_SECRET_ACCESS_KEY` | Server-only secret |
| `DEN_DRIVE_S3_SESSION_TOKEN` | Optional temporary-credential token |
| `DEN_DRIVE_S3_PREFIX` | Optional root, default `openwork-drive` |
| `DEN_DRIVE_S3_FORCE_PATH_STYLE` | `true` for providers requiring path-style requests |
| `DEN_DRIVE_QUOTA_BYTES` | Per-member ceiling, default 1 GiB |

Missing or invalid required configuration disables the feature. Configuration
presence is not a provider connectivity check. Keep public bucket access disabled;
the server identity needs GetObject, PutObject and DeleteObject only under the
configured root. No provider credential, signed URL, or bucket object key is
returned to a member or agent. Keep the endpoint, bucket and root stable: objects
record a storage identity and reject reads or deletion after relocation. Rotating
credentials for the same storage identity is supported.

## Member and administrator behavior

- **My Drive** lists the caller's private files, navigates folders, uploads a
  file, downloads it, and deletes it. Folders are inferred from file paths;
  opening a new folder and uploading creates its first file.
- Each organization membership owns its namespace. Another member, including
  an administrator, cannot read or delete those files through these APIs.
- Organization owners/admins open **Manage Drive access** to set the default
  allowance or an individual member's allowance and allowed folder patterns.
  `**` permits all folders; `reports/**` permits that folder and descendants.
  Comma-separated patterns form a union. The server ceiling always applies.
  Policies restrict reads, listings, uploads and deletes. A zero allowance blocks
  new bytes while permitting reads within granted folders.
- Limits are 8 MiB per file and 1,000 live files per member. Authenticated JSON
  transfers carry base64 bytes; the server bounds each body and admits at most
  eight simultaneous transfers per process. Downloads are attachment-only in
  the browser, with no document preview on the application's origin.
- The generated Den API/SDK and existing MCP catalog expose list, upload, read
  and delete operations under the same member identity. Headless runner and
  automation callers can discover these operations through their existing Den
  MCP connection. No runner-local filesystem mount is added.

## Accounting and recovery

An upload UUID identifies one immutable request. A durable reservation commits
under a member-row lock before S3 receives any bytes, so concurrent requests
across Den instances share the same quota. A retry of an acknowledged upload
returns the existing file without another provider write. Paths cannot overwrite
another file. Downloads check the recorded length and SHA-256.

If a provider reply is lost or the process stops during upload, the reservation
stays allocated and the file stays unavailable. This draft intentionally requires
operator reconciliation for unfinished uploads; it has no automatic janitor.
Operators must inspect the recorded object key and remove any corresponding
bytes before removing its reservation. Never release unknown usage blindly.
Deletion retains usage until S3 acknowledges deletion; the member can retry a
failed delete. Completed deletions retain a UUID tombstone, preventing a delayed
delete from affecting a later upload that reused the same object key.

Live membership and organization enablement are checked on every request, with
another check before an uploaded object becomes readable or bytes are returned.
Disabling an organization retains its files and restores access when re-enabled.
Organization/member deletion also retains private objects and metadata in this
draft; a reviewed retention/purge workflow is required before a production rollout.

## Next increments

Usage billing, paid overage, shared folders, teams, multiple storage profiles,
direct presigned or multipart transfers, scanning, automated reconciliation and
retention, run-specific grants, chat attachment controls and filesystem mounts
remain design work. The concept prototype explores those flows; it is not their
implementation. Verify each target provider's behavior with real deployment
credentials before offering this service to customers.
