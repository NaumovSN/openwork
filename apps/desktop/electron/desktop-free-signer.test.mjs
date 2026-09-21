import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  desktopFreeProofMessage, DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH,
  DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_CHAT_PATH,
  MEMBER_FREE_STATUS_PATH, MEMBER_FREE_MODELS_PATH, MEMBER_FREE_CHAT_PATH,
} from "@openwork/types/desktop-free-access";
import { createDesktopFreeSigner, desktopFreeBootstrapEligible } from "./desktop-free-signer.mjs";

function storage() {
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async (text) => Buffer.from(`fixture:${Buffer.from(text).toString("hex")}`),
    decryptStringAsync: async (bytes) => {
      assert.ok(bytes.toString().startsWith("fixture:"));
      return { result: Buffer.from(bytes.toString().slice(8), "hex").toString() };
    },
  };
}

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-free-signer-"));
  const options = { filePath: path.join(root, "identity.bin"), appVersion: "0.20.0", platform: process.platform, arch: "arm64", isEligible: () => true, loadSafeStorage: storage };
  try { await run(options, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("one protected installation signs the actual guest and member route, raw body, and authorization", async () => {
  await fixture(async (options) => {
    const first = createDesktopFreeSigner(options);
    const identity = await first.identity();
    const restarted = createDesktopFreeSigner(options);
    assert.deepEqual(await restarted.identity(), identity);
    assert.equal("privateKey" in identity, false);
    assert.equal((await readFile(options.filePath)).includes("privateKey"), false);
    if (process.platform !== "win32") assert.equal((await stat(options.filePath)).mode & 0o777, 0o600);
    const key = createPublicKey({ key: Buffer.from(identity.publicKey, "base64"), type: "spki", format: "der" });
    const nonces = new Set();
    for (const requestPath of [DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_STATUS_PATH, DESKTOP_FREE_MODELS_PATH, DESKTOP_FREE_CHAT_PATH, MEMBER_FREE_STATUS_PATH, MEMBER_FREE_MODELS_PATH, MEMBER_FREE_CHAT_PATH]) {
      const method = [DESKTOP_FREE_SESSION_PATH, DESKTOP_FREE_CHAT_PATH, MEMBER_FREE_CHAT_PATH].includes(requestPath) ? "POST" : "GET";
      const body = Buffer.from(method === "POST" ? '{ "model": "openai/gpt-5.6-luna" }' : "");
      const authorization = requestPath === DESKTOP_FREE_SESSION_PATH ? "" : "Bearer member-or-guest-fixture";
      const proof = JSON.parse(Buffer.from(await restarted.sign({ method, path: requestPath, body, authorization }), "base64url").toString());
      assert.equal(proof.appVersion, "0.20.0");
      assert.equal(nonces.has(proof.nonce), false);
      nonces.add(proof.nonce);
      const fields = { ...proof, method, path: requestPath, bodyHash: createHash("sha256").update(body).digest("hex"), authorizationHash: createHash("sha256").update(authorization).digest("hex") };
      const signature = Buffer.from(proof.signature, "base64url");
      assert.equal(verify(null, Buffer.from(desktopFreeProofMessage(fields)), key, signature), true);
      for (const changed of [{ path: "/other" }, { authorizationHash: createHash("sha256").update("Bearer other").digest("hex") }, { bodyHash: createHash("sha256").update("{}").digest("hex") }, { appVersion: "99.0.0" }]) {
        assert.equal(verify(null, Buffer.from(desktopFreeProofMessage({ ...fields, ...changed })), key, signature), false);
      }
    }
    await assert.rejects(first.sign({ method: "POST", path: "/arbitrary", body: new Uint8Array(), authorization: "" }), /Unsupported/);
    await assert.rejects(first.sign({ method: "GET", path: `${MEMBER_FREE_STATUS_PATH}?redirect=other`, body: new Uint8Array(), authorization: "" }), /Unsupported/);
  });
});

test("concurrent enrollment uses the same identity and corrupt or insecure storage never resets it", async () => {
  await fixture(async (options, root) => {
    const [a, b] = await Promise.all([createDesktopFreeSigner(options).identity(), createDesktopFreeSigner(options).identity()]);
    assert.deepEqual(a, b);
    await writeFile(options.filePath, "corrupt");
    await assert.rejects(createDesktopFreeSigner(options).identity());
    assert.equal(await readFile(options.filePath, "utf8"), "corrupt");
    assert.deepEqual(await readdir(root), ["identity.bin"]);
    await assert.rejects(createDesktopFreeSigner({ ...options, loadSafeStorage: () => ({ ...storage(), isAsyncEncryptionAvailable: async () => false }) }).identity(), /secure storage/);
    await assert.rejects(createDesktopFreeSigner({ ...options, platform: "linux", loadSafeStorage: () => ({ ...storage(), getSelectedStorageBackend: () => "basic_text" }) }).identity(), /secure storage/);
  });
});

test("public hosted eligibility respects explicit enterprise policies and no historical cohort imposes login", () => {
  const distribution = { flavor: "public" };
  const bootstrap = { baseUrl: "https://app.openworklabs.com", requireSignin: false };
  assert.equal(desktopFreeBootstrapEligible(distribution, bootstrap), true);
  assert.equal(desktopFreeBootstrapEligible(distribution, { ...bootstrap, apiBaseUrl: "https://api.app.openworklabs.com" }), true);
  for (const apiBaseUrl of ["https://api.app.openworklabs.com.foreign.test", "https://foreign-api.app.openworklabs.com", "http://api.app.openworklabs.com", "https://api.app.openworklabs.com:8443"]) {
    assert.equal(desktopFreeBootstrapEligible(distribution, { ...bootstrap, apiBaseUrl }), false);
  }
  assert.equal(desktopFreeBootstrapEligible(distribution, { ...bootstrap, installationRequiresSignin: true }), true);
  for (const denied of [{ ...bootstrap, requireSignin: true }, { ...bootstrap, requireActivation: true }, { ...bootstrap, baseUrl: "https://selfhosted.test" }, { ...bootstrap, apiBaseUrl: "https://selfhosted.test" }]) {
    assert.equal(desktopFreeBootstrapEligible(distribution, denied), false);
  }
  assert.equal(desktopFreeBootstrapEligible({ flavor: "enterprise" }, bootstrap), false);
});

test("a loopback control plane is eligible only when developer mode names it explicitly", () => {
  const distribution = { flavor: "public" };
  const local = { baseUrl: "http://localhost:3005", requireSignin: false, requireActivation: false };
  assert.equal(desktopFreeBootstrapEligible(distribution, local, {}), false);
  assert.equal(desktopFreeBootstrapEligible(distribution, local, { OPENWORK_DEV_FREE_CONTROL_PLANE: "http://localhost:3005" }), false);
  assert.equal(desktopFreeBootstrapEligible(distribution, local, { OPENWORK_DEV_MODE: "1" }), false);
  assert.equal(desktopFreeBootstrapEligible(distribution, local, { OPENWORK_DEV_MODE: "1", OPENWORK_DEV_FREE_CONTROL_PLANE: "http://localhost:3005" }), true);
  assert.equal(desktopFreeBootstrapEligible(distribution, { ...local, baseUrl: "http://localhost:3015" }, { OPENWORK_DEV_MODE: "1", OPENWORK_DEV_FREE_CONTROL_PLANE: "http://localhost:3005" }), false);
  assert.equal(desktopFreeBootstrapEligible(distribution, { ...local, baseUrl: "http://den.example.test" }, { OPENWORK_DEV_MODE: "1", OPENWORK_DEV_FREE_CONTROL_PLANE: "http://den.example.test" }), false);
  assert.equal(desktopFreeBootstrapEligible({ flavor: "enterprise" }, local, { OPENWORK_DEV_MODE: "1", OPENWORK_DEV_FREE_CONTROL_PLANE: "http://localhost:3005" }), false);
  assert.equal(desktopFreeBootstrapEligible(distribution, { ...local, apiBaseUrl: "http://localhost:8788" }, { OPENWORK_DEV_MODE: "1", OPENWORK_DEV_FREE_CONTROL_PLANE: "http://localhost:3005" }), true);
  assert.equal(desktopFreeBootstrapEligible(distribution, { ...local, apiBaseUrl: "https://api.example.test" }, { OPENWORK_DEV_MODE: "1", OPENWORK_DEV_FREE_CONTROL_PLANE: "http://localhost:3005" }), false);
});
