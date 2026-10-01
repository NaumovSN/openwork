import assert from "node:assert/strict"
import { test } from "node:test"
import { cloudDriveEnabled, driveMemberPolicy, drivePathAllowed, drivePathSchema, readDriveStorageConfig } from "../src/cloud-drive-config.js"

const configured = { DEN_DRIVE_S3_ENDPOINT: "https://storage.example.test", DEN_DRIVE_S3_REGION: "auto", DEN_DRIVE_S3_BUCKET: "drive-test", DEN_DRIVE_S3_ACCESS_KEY_ID: "synthetic-key", DEN_DRIVE_S3_SECRET_ACCESS_KEY: "synthetic-secret" }

test("Drive requires both complete server configuration and literal organization enablement", () => {
  assert.equal(readDriveStorageConfig({}), null)
  for (const key of Object.keys(configured)) assert.equal(readDriveStorageConfig({ ...configured, [key]: undefined }), null)
  assert.ok(readDriveStorageConfig(configured))
  for (const configured of [false, true]) for (const flag of [undefined, false, true, "true", 1]) {
    assert.equal(cloudDriveEnabled({ capabilities: { cloudDrive: flag } }, configured), configured && flag === true)
  }
  assert.equal(readDriveStorageConfig({ ...configured, DEN_DRIVE_S3_ENDPOINT: "http://outside.example.test" }), null)
  assert.equal(readDriveStorageConfig({ ...configured, DEN_DRIVE_S3_ENDPOINT: "https://secret@storage.example.test" }), null)
})

test("folder grants cannot escape member namespaces and invalid stored policy denies access", () => {
  const policy = driveMemberPolicy({ cloudDrivePolicy: { default: { quotaBytes: 100, allowedFolders: ["reports/**"] }, members: { om_member: { quotaBytes: 20, allowedFolders: ["projects/**"] } } } }, "om_member", 10)
  assert.equal(policy.quotaBytes, 10)
  assert.equal(drivePathAllowed("projects/file.txt", policy), true)
  for (const path of ["projects-other/file.txt", "reports/file.txt", "/projects/file.txt", "projects/../file.txt", "projects\\file.txt", "projects//file.txt", "projects/\u0000file.txt"]) assert.equal(drivePathAllowed(path, policy), false)
  assert.equal(drivePathSchema.safeParse("projects/cafe\u0301.txt").success, false)
  const invalid = driveMemberPolicy({ cloudDrivePolicy: { default: { allowedFolders: ["**"] } } }, "om_member", 100)
  assert.equal(invalid.quotaBytes, 0)
  assert.equal(drivePathAllowed("file.txt", invalid), false)
})
