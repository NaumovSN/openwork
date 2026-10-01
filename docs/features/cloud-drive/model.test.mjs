import { test } from "node:test";
import assert from "node:assert/strict";
import { DriveDemo, createDemoState, matchesFolder, safePath, MiB, GiB } from "./model.mjs";

const setup = () => {
  const model = new DriveDemo();
  return { model, actor: model.state.actor };
};
const request = (key, size = MiB, path = "Reports/new.md", driveId = "drive_private") => ({
  idempotencyKey: key, declaredBytes: size, path, driveId,
});
const scope = (actor) => ({
  id: "run_demo", organizationId: actor.organizationId, memberId: actor.memberId,
  driveIds: ["drive_private"], readFolders: ["Reports/**"], writeFolders: ["Reports/automations/**"],
  maxWriteBytes: 2 * MiB, expiresAt: Date.now() + 60_000,
});

test("an organization member cannot read or write another member's private namespace", () => {
  const { model, actor } = setup();
  assert.equal(model.access(actor, "drive_other", "Reports/secret.md", "read").code, "access_denied");
  assert.equal(model.reserveUpload(actor, request("other", MiB, "Reports/new.md", "drive_other")).code, "access_denied");
  assert.equal(model.access({ ...actor, organizationId: "org_other" }, "drive_private", "Reports/new.md", "read").code, "membership_required");
});

test("team report access allows reading and blocks file creation", () => {
  const { model, actor } = setup();
  assert.equal(model.access(actor, "drive_team", "Reports/team-plan.pdf", "read").ok, true);
  assert.equal(model.reserveUpload(actor, request("team", MiB, "Reports/new.md", "drive_team")).code, "access_denied");
});

test("an explicit folder deny overrides private-drive ownership", () => {
  const { model, actor } = setup();
  assert.equal(model.access(actor, "drive_private", "Documents/restricted/payroll.csv", "read").code, "folder_denied");
  assert.equal(model.reserveUpload(actor, request("deny", MiB, "Documents/restricted/new.md")).code, "folder_denied");
});

test("folder boundaries do not match similarly named folders or traversal", () => {
  assert.equal(matchesFolder("Reports/**", "Reports/new.md"), true);
  assert.equal(matchesFolder("Reports/**", "Reports-private/new.md"), false);
  for (const path of ["../Reports/new.md", "/Reports/new.md", "Reports/../other.md", "Reports\\other.md", "Reports/%2e%2e/other.md", "Reports//other.md", "Reports/./other.md", "Reports/\u0000.md"]) {
    assert.equal(safePath(path), null, path);
  }
});

test("a run's folder and operation scope intersects with the member's permissions", () => {
  const { model, actor } = setup();
  const run = scope(actor);
  assert.equal(model.access(actor, "drive_private", "Documents/brief.md", "read", run).code, "run_scope_denied");
  assert.equal(model.reserveUpload(actor, request("outside", MiB, "Reports/new.md"), run).code, "run_scope_denied");
  assert.equal(model.reserveUpload(actor, request("inside", MiB, "Reports/automations/new.md"), run).ok, true);
  assert.equal(model.reserveUpload(actor, request("wrong-actor", MiB, "Reports/automations/wrong.md"), { ...run, memberId: "member_other" }).code, "run_scope_denied");
});

test("pending reservations prevent a second writer exceeding capacity", () => {
  const { model, actor } = setup();
  const drive = model.state.drives[0];
  drive.limitBytes = model.usage(drive.id).used + 10 * MiB;
  assert.equal(model.reserveUpload(actor, request("one", 8 * MiB, "Reports/one.md")).ok, true);
  assert.equal(model.reserveUpload(actor, request("two", 8 * MiB, "Reports/two.md")).code, "drive_full");
  assert.equal(model.usage(drive.id).reserved, 8 * MiB);
});

test("the organization ceiling also applies to a member with free capacity", () => {
  const { model, actor } = setup();
  const used = model.state.drives.reduce((sum, drive) => sum + model.usage(drive.id).used, 0);
  model.state.organizationLimitBytes = used + MiB;
  assert.equal(model.reserveUpload(actor, request("pool", 2 * MiB)).code, "organization_full");
});

test("run output capacity covers all files and pending transfers in the run", () => {
  const { model, actor } = setup();
  const run = scope(actor);
  const first = model.reserveUpload(actor, request("first", MiB, "Reports/automations/first.md"), run);
  assert.equal(first.ok, true);
  assert.equal(model.completeUpload(actor, first.intent.id, MiB).ok, true);
  assert.equal(model.reserveUpload(actor, request("second", 2 * MiB, "Reports/automations/second.md"), run).code, "run_limit");
});

test("replaying a request and completion stores one file and charges once", () => {
  const { model, actor } = setup();
  const before = model.usage("drive_private").used;
  const input = request("repeat");
  const first = model.reserveUpload(actor, input);
  const repeated = model.reserveUpload(actor, input);
  assert.equal(repeated.intent.id, first.intent.id);
  assert.equal(model.usage("drive_private").reserved, MiB);
  const completion = model.completeUpload(actor, first.intent.id, MiB);
  assert.equal(model.completeUpload(actor, first.intent.id, MiB).file.id, completion.file.id);
  assert.equal(model.reserveUpload(actor, input).intent.status, "completed");
  assert.equal(model.events.length, 1);
  assert.equal(model.usage("drive_private").used, before + MiB);
  assert.equal(model.usage("drive_private").reserved, 0);
});

test("an idempotency identity cannot be reused for a different destination or size", () => {
  const { model, actor } = setup();
  model.reserveUpload(actor, request("bound"));
  assert.equal(model.reserveUpload(actor, request("bound", 2 * MiB)).code, "idempotency_conflict");
  assert.equal(model.reserveUpload(actor, request("bound", MiB, "Reports/elsewhere.md")).code, "idempotency_conflict");
});

test("membership and folder revocation prevent committing an admitted upload", () => {
  const { model, actor } = setup();
  const admitted = model.reserveUpload(actor, request("revoked"));
  assert.equal(model.completeUpload({ ...actor, active: false }, admitted.intent.id, MiB).code, "membership_required");
  model.state.drives[0].rules.push({ effect: "deny", pattern: "Reports/**", operations: ["create"] });
  assert.equal(model.completeUpload(actor, admitted.intent.id, MiB).code, "folder_denied");
  assert.equal(model.events.length, 0);
});

test("another member cannot finalize a known upload intent", () => {
  const { model, actor } = setup();
  const admitted = model.reserveUpload(actor, request("owned"));
  assert.equal(model.completeUpload({ ...actor, memberId: "member_jordan" }, admitted.intent.id, MiB).code, "access_denied");
});

test("an oversized verified object cannot become a ready file", () => {
  const { model, actor } = setup();
  const admitted = model.reserveUpload(actor, request("oversize"));
  assert.equal(model.completeUpload(actor, admitted.intent.id, 2 * MiB).code, "size_mismatch");
  assert.equal(model.usage("drive_private").reserved, MiB);
  assert.equal(model.events.length, 0);
  assert.equal(model.reserveUpload(actor, request("huge", GiB)).code, "file_limit");
});

test("expired empty reservations release capacity and cannot later commit", () => {
  let now = 1000;
  const model = new DriveDemo(createDemoState(), () => now);
  const actor = model.state.actor;
  const admitted = model.reserveUpload(actor, request("expired"));
  now += 6 * 60_000;
  assert.equal(model.completeUpload(actor, admitted.intent.id, MiB).code, "intent_expired");
  model.expireEmptyReservations();
  assert.equal(model.usage("drive_private").reserved, 0);
  assert.equal(model.completeUpload(actor, admitted.intent.id, MiB).code, "intent_expired");
});

test("quota reduction preserves existing files and reads while blocking growth", () => {
  const { model, actor } = setup();
  model.state.drives[0].limitBytes = MiB;
  assert.equal(model.access(actor, "drive_private", "Reports/weekly-review.pdf", "read").ok, true);
  assert.equal(model.reserveUpload(actor, request("full")).code, "drive_full");
  assert.equal(model.state.drives[0].files.length, 4);
});

test("competing same-name uploads cannot replace a committed result", () => {
  const { model, actor } = setup();
  const one = model.reserveUpload(actor, request("name-one"));
  const two = model.reserveUpload(actor, request("name-two"));
  assert.equal(model.completeUpload(actor, one.intent.id, MiB).ok, true);
  assert.equal(model.completeUpload(actor, two.intent.id, MiB).code, "name_conflict");
  assert.equal(model.events.length, 1);
});

test("a limit reduction after admission is enforced again at commit", () => {
  const { model, actor } = setup();
  const admitted = model.reserveUpload(actor, request("lowered"));
  model.state.drives[0].limitBytes = model.usage("drive_private").used;
  assert.equal(model.completeUpload(actor, admitted.intent.id, MiB).code, "drive_full");
  assert.equal(model.events.length, 0);
  assert.equal(model.usage("drive_private").reserved, MiB);
});

test("an expired run cannot admit new work or commit a reserved result", () => {
  let now = Date.now();
  const model = new DriveDemo(createDemoState(), () => now);
  const actor = model.state.actor;
  const run = scope(actor);
  const admitted = model.reserveUpload(actor, request("run-expiry", MiB, "Reports/automations/expiry.md"), run);
  assert.equal(admitted.ok, true);
  now = run.expiresAt + 1;
  assert.equal(model.completeUpload(actor, admitted.intent.id, MiB).code, "run_scope_denied");
  assert.equal(model.reserveUpload(actor, request("run-after-expiry", MiB, "Reports/automations/late.md"), run).code, "run_scope_denied");
});
