import type { Seed } from "@openwork/env";

/** Rollout and policy journey only; no request reaches a storage provider. */
export async function cloudDriveRollout(seed: Seed) {
  const name = "Drive rollout workspace";
  const den = await seed.den({
    web: true,
    env: {
      DEN_ORG_MODE: "multi_org", PROVISIONER_MODE: "stub", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
      DEN_DRIVE_S3_ENDPOINT: "http://127.0.0.1:1", DEN_DRIVE_S3_REGION: "test", DEN_DRIVE_S3_BUCKET: "synthetic-drive",
      DEN_DRIVE_S3_ACCESS_KEY_ID: "synthetic-key", DEN_DRIVE_S3_SECRET_ACCESS_KEY: "synthetic-secret", DEN_DRIVE_S3_FORCE_PATH_STYLE: "true",
    },
    org: { name, admin: { name: "Drive Owner" }, members: { teammate: { name: "Teammate" } } },
  });
  const teammate = den.members.teammate;
  if (!teammate) throw new Error("Expected a synthetic teammate session");
  const body = (await seed.api(den.admin, "/v1/org")).body;
  if (!body || typeof body !== "object" || !("organization" in body)) throw new Error("Missing organization");
  const organization = body.organization;
  if (!organization || typeof organization !== "object" || !("id" in organization) || typeof organization.id !== "string") throw new Error("Missing organization id");
  const viewport = { width: 1440, height: 1000 };
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard", headless: true, viewport });
  const adminWeb = await seed.web({ den, signedInAs: den.admin, startPath: "/admin", headless: true, viewport });
  const memberWeb = await seed.web({ den, signedInAs: teammate, startPath: "/dashboard", headless: true, viewport });
  return { den, teammate, web, adminWeb, memberWeb, orgId: organization.id, name };
}
