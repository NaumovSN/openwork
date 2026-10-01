# Local concept verification

October 1, 2026 · Local branch `feature/member-cloud-drive`.
Base: fetched `different-ai/openwork:dev@74232f4c1ef9f7b051a23f8374bc768d0a29b217`.

## Passed

- `node --test docs/features/cloud-drive/model.test.mjs`: 18 tests passed,
  0 failed, 0 skipped. These exercise the shared in-memory concept model:
  membership and private-drive isolation, team read-only access, explicit deny,
  path boundaries, run-scope intersection and expiry, member/org/run quota
  reservations, replay, conflicting idempotency requests, revocation, size
  mismatch, empty-intent expiry, lowered limits and same-name conflicts.
- `node --check docs/features/cloud-drive/preview.mjs`: passed.
- Browser walkthrough: reserve and finish a 1 MiB sample upload; the new row
  appears and used capacity increases once.
- Browser walkthrough: Team reports remains readable and exposes a blocked
  upload control with its admin-controlled reason.
- Browser walkthrough: apply a 0.25 GiB member limit, then attempt a new
  40 MiB file. Admission is blocked without adding a row.
- Browser walkthrough: save a 20 KiB sample automation output, open its output
  folder, and find `daily-summary.md` with Automation attribution.
- Browser walkthrough: empty state shows 0 files and 0 usage; unverified
  storage preserves the sample file list and offers Retry.
- Browser inspection: self-hosted endpoint, region, bucket, addressing,
  identity root, member profile and limits are available; connection and
  credentials remain explicitly unverified/unconfigured.
- Browser console inspection after the final walkthrough: no captured warning
  or error entries.

## Screenshots

All content is synthetic. These are concept screenshots, not shipping evidence.

- [Member drive with automation output](screenshots/my-drive.jpg)
- [Self-hosted admin controls](screenshots/self-hosted-settings.jpg)
- [Automation result](screenshots/automation-result.jpg)
- [Quota blocked](screenshots/quota-blocked.jpg)
- [Empty drive](screenshots/empty.jpg)
- [Unverified storage](screenshots/unverified.jpg)

## Deferred to implementation

No S3 credentials were retrieved. No external service was configured, no
content was uploaded, and no model or automation ran. Provider SDK behavior,
database locking/concurrency, actual stream size enforcement, scanning,
multipart cleanup, restart recovery, real MCP integration, transfer metrics,
billing and the real app/Den UI have not been implemented or verified.

The prototype applies synthetic member quotas and team read/create access.
Provider, credential and profile-assignment controls illustrate the intended
configuration; they do not persist or configure a backend. Its metadata-only
reservation lifecycle does not represent orphaned bytes or physical deletion.
Those production requirements are defined in `architecture.md`.

No package install, large build, full system tests, push, PR, deployment or
communication to another chat was performed. The sparse worktree is retained
as the requested local candidate and because its local preview uses it.
