# Draft implementation verification

October 1, 2026 · Local `feature/member-cloud-drive`, based on fetched upstream
`dev@daa1f9fe1`. Verification used synthetic identities and a disposable loopback
MySQL database. No customer storage credentials or paid service were used.

- Focused configuration, policy and SQL/S3 integration checks: four passed.
  A local HTTP provider fixture received actual AWS SDK signed PutObject,
  GetObject and DeleteObject calls. Concurrent six-byte uploads shared a
  ten-byte limit: one succeeded and one was rejected. A successful retry wrote
  once; another member could neither read nor delete. Failed deletion retained
  quota until retry. Uncertain writes retained their reservations. Removed
  membership, disabled organization and disallowed folders denied access.
- Real Hono route checks: disabled Drive returns 404; quota returns 409;
  missing files return 404; provider failures return 503 without exposing the
  provider error; a member's policy-management request returns 403.
- Organization capability checks: 18 passed. Organization metadata/auth checks:
  29 passed, including denial of Cloud Drive enrollment through public org
  creation. Navigation checks: 17 passed, including absence from navigation
  and search unless the effective flag is true.
- Den API, Den Web and generated SDK TypeScript checks completed without errors.
  The database migration and API/SDK contract were generated from the source.
- `evals/specs/cloud-drive-rollout.e2e.test.ts`: local browser journey passed,
  one test, zero failures/skips. Its four recorded steps show hidden Drive and
  HTTP 404 before rollout, a real `/admin` organization checkbox enabling it,
  owner-set limits persisted by Den, and a teammate seeing those limits while
  policy administration returns HTTP 403. Screenshots are recorded by the spec;
  CI owns publication on the PR head.

Run focused checks with `pnpm --filter @openwork-ee/den-api test:drive` and
`pnpm --filter @openwork-ee/den-api test:drive:db`. The latter requires an empty
or fixture-owned loopback database ending in `_drive_test` through
`DEN_DRIVE_TEST_DATABASE_URL`; it creates only the affected tables and removes
its synthetic rows. Run the UI journey with
`pnpm evals:e2e cloud-drive-rollout --local`.

The browser journey covers rollout and policy, not an external storage provider
or file-picker upload. Real cloud-provider compatibility, production credentials,
paid usage, scanning, automatic orphan reconciliation, retention/purge, large
multipart uploads and run-specific scopes remain unverified or unimplemented.
See [implementation.md](implementation.md) for the current scope and limits.

---

# Earlier local concept verification

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
