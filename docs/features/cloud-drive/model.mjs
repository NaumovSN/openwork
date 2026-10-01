// Metadata-only model for the local pitch. This is not a storage service.
export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;

const blocked = (code, message) => ({ ok: false, code, message });
const copy = (value) => structuredClone(value);

export function safePath(input) {
  if (typeof input !== "string" || !input || input.length > 512) return null;
  if (input.startsWith("/") || /[\\%\u0000-\u001f\u007f]/.test(input)) return null;
  const segments = input.normalize("NFC").split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || part.includes(":"))) return null;
  return segments.join("/");
}

// Intentionally small pattern language: ** or an anchored folder/**.
export function matchesFolder(pattern, path) {
  if (!safePath(path)) return false;
  if (pattern === "**") return true;
  if (typeof pattern !== "string" || !pattern.endsWith("/**")) return false;
  const prefix = pattern.slice(0, -3);
  if (!safePath(prefix) || prefix.includes("*")) return false;
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function createDemoState() {
  return {
    actor: { organizationId: "org_demo", memberId: "member_avery", active: true, teamIds: ["team_operations"] },
    organizationId: "org_demo",
    organizationLimitBytes: 4 * GiB,
    drives: [
      {
        id: "drive_private", organizationId: "org_demo", ownerMemberId: "member_avery", name: "My drive",
        limitBytes: GiB, maxFileBytes: 250 * MiB, grants: [],
        rules: [{ effect: "deny", pattern: "Documents/restricted/**", operations: ["read", "create"] }],
        files: [
          { id: "file_review", path: "Reports/weekly-review.pdf", size: 18 * MiB, source: "You" },
          { id: "file_metrics", path: "Reports/metrics.csv", size: 2 * MiB, source: "You" },
          { id: "file_brief", path: "Documents/brief.md", size: 10486, source: "You" },
          { id: "file_research", path: "Uploads/product-research.zip", size: 210 * MiB, source: "You" },
        ],
      },
      {
        id: "drive_team", organizationId: "org_demo", ownerMemberId: null, name: "Team reports",
        limitBytes: 2 * GiB, maxFileBytes: 250 * MiB,
        grants: [{ teamId: "team_operations", pattern: "**", operations: ["read"] }], rules: [],
        files: [{ id: "file_team", path: "Reports/team-plan.pdf", size: 80 * MiB, source: "Team" }],
      },
      {
        id: "drive_other", organizationId: "org_demo", ownerMemberId: "member_jordan", name: "Another member's drive",
        limitBytes: GiB, maxFileBytes: 250 * MiB, grants: [], rules: [], files: [],
      },
    ],
  };
}

export class DriveDemo {
  constructor(state = createDemoState(), now = () => Date.now()) {
    this.state = copy(state);
    this.now = now;
    this.intents = new Map();
    this.idempotency = new Map();
    this.events = [];
    this.sequence = 0;
  }

  access(actor, driveId, path, operation, runScope = null) {
    if (!actor?.active || actor.organizationId !== this.state.organizationId) {
      return blocked("membership_required", "Drive access needs an active membership in this organization.");
    }
    const drive = this.state.drives.find((entry) => entry.id === driveId && entry.organizationId === actor.organizationId);
    if (!drive) return blocked("access_denied", "This drive is not available to your membership.");
    const normalized = safePath(path);
    if (!normalized) return blocked("invalid_path", "Choose a relative folder path without traversal or encoded separators.");
    const allowed = drive.ownerMemberId === actor.memberId || drive.grants.some((grant) =>
      (grant.memberId === actor.memberId || actor.teamIds.includes(grant.teamId)) &&
      grant.operations.includes(operation) && matchesFolder(grant.pattern, normalized));
    if (!allowed) return blocked("access_denied", operation === "create"
      ? "This folder is read-only. Your team admin can change its access."
      : "This folder is not available to your membership.");
    if (drive.rules.some((rule) => rule.effect === "deny" && rule.operations.includes(operation) && matchesFolder(rule.pattern, normalized))) {
      return blocked("folder_denied", "Your team admin has blocked this folder.");
    }
    if (runScope) {
      const patterns = operation === "create" ? runScope.writeFolders : runScope.readFolders;
      if (runScope.organizationId !== actor.organizationId || runScope.memberId !== actor.memberId ||
        runScope.expiresAt <= this.now() || !runScope.driveIds.includes(driveId) ||
        !patterns.some((pattern) => matchesFolder(pattern, normalized))) {
        return blocked("run_scope_denied", "This run is not allowed to access that folder or operation.");
      }
    }
    return { ok: true, path: normalized };
  }

  usage(driveId) {
    const drive = this.state.drives.find((entry) => entry.id === driveId);
    if (!drive) return null;
    const used = drive.files.reduce((sum, file) => sum + file.size, 0);
    const reserved = [...this.intents.values()].filter((intent) => intent.driveId === driveId && intent.status === "reserved")
      .reduce((sum, intent) => sum + intent.declaredBytes, 0);
    return { used, reserved, limit: drive.limitBytes, available: Math.max(0, drive.limitBytes - used - reserved) };
  }

  reserveUpload(actor, request, runScope = null) {
    const access = this.access(actor, request.driveId, request.path, "create", runScope);
    if (!access.ok) return access;
    if (!Number.isSafeInteger(request.declaredBytes) || request.declaredBytes < 1) return blocked("invalid_size", "Choose a positive whole-byte file size.");
    if (typeof request.idempotencyKey !== "string" || !request.idempotencyKey) return blocked("idempotency_required", "This upload needs a request identity.");
    const identity = JSON.stringify([actor.organizationId, actor.memberId, request.idempotencyKey]);
    const fingerprint = JSON.stringify([request.driveId, access.path, request.declaredBytes, runScope]);
    const existingId = this.idempotency.get(identity);
    if (existingId) {
      const existing = this.intents.get(existingId);
      return existing.fingerprint === fingerprint
        ? { ok: true, intent: copy(existing), replay: true }
        : blocked("idempotency_conflict", "That request identity is already bound to another upload.");
    }
    const drive = this.state.drives.find((entry) => entry.id === request.driveId);
    if (drive.files.some((file) => file.path === access.path)) return blocked("name_conflict", "A file already has that name. Choose another name.");
    if (request.declaredBytes > drive.maxFileBytes) return blocked("file_limit", "This file exceeds your team's per-file limit.");
    const usage = this.usage(drive.id);
    if (usage.used + usage.reserved + request.declaredBytes > usage.limit) return blocked("drive_full", "Your drive limit would be exceeded. Your team admin can raise it.");
    const orgUsage = this.state.drives.map((entry) => this.usage(entry.id)).reduce((sum, entry) => sum + entry.used + entry.reserved, 0);
    if (orgUsage + request.declaredBytes > this.state.organizationLimitBytes) return blocked("organization_full", "Your organization's storage limit would be exceeded.");
    if (runScope) {
      const runUsed = this.events.filter((event) => event.runId === runScope.id).reduce((sum, event) => sum + event.bytes, 0);
      const runReserved = [...this.intents.values()].filter((intent) => intent.runScope?.id === runScope.id && intent.status === "reserved")
        .reduce((sum, intent) => sum + intent.declaredBytes, 0);
      if (runUsed + runReserved + request.declaredBytes > runScope.maxWriteBytes) return blocked("run_limit", "This run's total output limit would be exceeded.");
    }
    const intent = {
      id: `upload_${++this.sequence}`, organizationId: actor.organizationId, memberId: actor.memberId,
      driveId: drive.id, path: access.path, declaredBytes: request.declaredBytes,
      fingerprint, status: "reserved", expiresAt: this.now() + 5 * 60 * 1000,
      runScope: runScope ? copy(runScope) : null,
    };
    this.intents.set(intent.id, intent);
    this.idempotency.set(identity, intent.id);
    return { ok: true, intent: copy(intent), replay: false };
  }

  completeUpload(actor, intentId, verifiedBytes) {
    const intent = this.intents.get(intentId);
    if (!intent || intent.organizationId !== actor.organizationId || intent.memberId !== actor.memberId) return blocked("access_denied", "This upload is not available to your membership.");
    const access = this.access(actor, intent.driveId, intent.path, "create", intent.runScope);
    if (!access.ok) return access;
    if (intent.status === "completed") return { ok: true, file: copy(intent.file), replay: true };
    if (intent.status !== "reserved" || intent.expiresAt <= this.now()) return blocked("intent_expired", "This upload reservation expired. Start a fresh upload.");
    if (!Number.isSafeInteger(verifiedBytes) || verifiedBytes < 1 || verifiedBytes > intent.declaredBytes) return blocked("size_mismatch", "The verified file exceeds its reserved size or has an invalid size.");
    const drive = this.state.drives.find((entry) => entry.id === intent.driveId);
    const usage = this.usage(drive.id);
    if (usage.used + usage.reserved > usage.limit || verifiedBytes > drive.maxFileBytes) return blocked("drive_full", "Your team lowered the storage or file limit. This upload cannot be committed.");
    const orgUsage = this.state.drives.reduce((sum, entry) => {
      const current = this.usage(entry.id);
      return sum + current.used + current.reserved;
    }, 0);
    if (orgUsage > this.state.organizationLimitBytes) return blocked("organization_full", "Your organization's storage limit changed. This upload cannot be committed.");
    if (drive.files.some((file) => file.path === intent.path)) return blocked("name_conflict", "Another upload used that filename. Choose another name.");
    const file = { id: `file_${++this.sequence}`, path: intent.path, size: verifiedBytes, source: intent.runScope ? "Automation" : "You" };
    drive.files.push(file);
    intent.file = file;
    intent.status = "completed";
    this.events.push({ id: `committed:${intent.id}`, bytes: verifiedBytes, runId: intent.runScope?.id ?? null });
    return { ok: true, file: copy(file), replay: false };
  }

  // Only empty/metadata-only reservations expire here. A real service must
  // retain accounting for partial/orphaned bytes until cleanup is acknowledged.
  expireEmptyReservations() {
    for (const intent of this.intents.values()) {
      if (intent.status === "reserved" && intent.expiresAt <= this.now()) intent.status = "expired";
    }
  }
}
