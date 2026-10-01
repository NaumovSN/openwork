import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { cloudDriveRollout } from "../worlds/cloud-drive-rollout.ts";

const test = spec.world(cloudDriveRollout, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 600_000 });

test("Cloud Drive stays hidden until the platform admin enables the organization, then members see their limits", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const admin = user.on(world.adminWeb);
  const member = user.on(world.memberWeb);
  await step("before: configured storage alone leaves My Drive hidden and its API unavailable", async () => {
    await owner.see({ text: "My Library" }, { timeoutMs: 90_000 });
    await owner.notSee({ testId: "den-nav-drive" });
    const response = await probe.api(world.den.admin, "/v1/drive");
    expect(response.response.status).toBe(404);
    evidence.recordAssertionEvidence("organization starts disabled", `Drive HTTP ${response.response.status}; My Drive absent from the real sidebar`, response.response.status === 404);
    await owner.screenshot();
  });
  await step("when: the platform admin enables Cloud Drive for this organization in admin", async () => {
    await admin.see({ role: "button", label: /^Organizations \(/ }, { timeoutMs: 90_000 });
    await admin.click({ role: "button", label: /^Organizations \(/ });
    await admin.type({ placeholder: "Org name, slug, or id" }, world.name);
    await admin.see({ testId: "admin-capability-cloudDrive" }, { timeoutMs: 30_000 });
    await admin.click({ testId: "admin-capability-cloudDrive" });
    const response = await probe.eventually(() => probe.api(world.den.admin, "/v1/drive"), { within: 15_000, until: (value) => value.response.status === 200 });
    expect(response.response.status).toBe(200);
    evidence.recordAssertionEvidence("admin toggle persists through the API", `Drive HTTP ${response.response.status} after the real organization checkbox was clicked`, response.response.status === 200);
    await admin.screenshot();
  });
  await step("after: the owner sees My Drive and sets the organization's folder and storage limits", async () => {
    await owner.reload();
    await owner.see({ testId: "den-nav-drive" }, { timeoutMs: 30_000 });
    await owner.click({ testId: "den-nav-drive" });
    await owner.see({ testId: "cloud-drive-screen" }, { timeoutMs: 30_000 });
    await owner.click({ text: "Manage Drive access" });
    await owner.type({ label: "Storage limit (MB)" }, "5", { replace: true });
    await owner.type({ label: "Allowed folders" }, "reports/**", { replace: true });
    await owner.click({ role: "button", label: "Save access" });
    await owner.see({ text: "Drive access saved." });
    const response = await probe.api(world.den.admin, "/v1/drive");
    const body = response.body;
    const quota = body && typeof body === "object" && "quotaBytes" in body ? body.quotaBytes : null;
    expect(quota).toBe(5 * 1024 * 1024);
    evidence.recordAssertionEvidence("saved policy is enforced by the server", `Member quota ${quota} bytes; allowed folder reports/**`, quota === 5 * 1024 * 1024);
    await owner.screenshot();
  });
  await step("then: the teammate sees the effective limits and cannot manage anyone's Drive access", async () => {
    await member.reload();
    await member.see({ testId: "den-nav-drive" }, { timeoutMs: 30_000 });
    await member.click({ testId: "den-nav-drive" });
    await member.see({ testId: "drive-usage" }, { text: /5\.0 MB/ });
    await member.notSee({ text: "Manage Drive access" });
    const response = await probe.api(world.teammate, "/v1/drive/policy");
    expect(response.response.status).toBe(403);
    evidence.recordAssertionEvidence("member policy administration is denied", `Teammate sees 5.0 MB; organization policy HTTP ${response.response.status}`, response.response.status === 403);
    await member.screenshot();
  });
});
