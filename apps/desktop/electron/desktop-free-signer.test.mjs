import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDesktopFreeSigner } from "./desktop-free-signer.mjs";

const MACHINE_ID = "a".repeat(64);

function keyring({ available = true, backend = "gnome_libsecret" } = {}) {
  const wrap = (value) => Buffer.from(`enc:${value}`);
  return {
    isAsyncEncryptionAvailable: async () => available,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (value) => wrap(value),
    decryptStringAsync: async (buffer) => ({ result: buffer.toString("utf8").replace(/^enc:/, "") }),
  };
}

function signer(directory, loadSafeStorage) {
  return createDesktopFreeSigner({
    filePath: path.join(directory, "desktop-free-identity.bin"),
    loadSafeStorage,
    appVersion: "0.0.0-test",
    platform: "linux",
    arch: "x64",
    isEligible: () => true,
    readMachineId: async () => MACHINE_ID,
  });
}

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "desktop-free-signer-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

describe("desktop free signer identity storage", () => {
  it("works without an OS keyring, keeping the key in an owner-only file", async () => {
    await withDirectory(async (directory) => {
      for (const storage of [null, keyring({ available: false }), keyring({ backend: "basic_text" })]) {
        await rm(path.join(directory, "desktop-free-identity.json"), { force: true });
        const first = await signer(directory, () => storage).identity();
        assert.equal(first.machineId, MACHINE_ID);
        assert.deepEqual(await readdir(directory), ["desktop-free-identity.json"]);
        if (process.platform !== "win32") {
          assert.equal((await stat(path.join(directory, "desktop-free-identity.json"))).mode & 0o777, 0o600);
        }
        const again = await signer(directory, () => storage).identity();
        assert.equal(again.publicKey, first.publicKey);
        assert.ok(await signer(directory, () => storage).sign({ method: "POST", path: "/api/v1/chat/completions", body: "{}", authorization: "" }));
      }
    });
  });

  it("uses the keyring when available and keeps an existing identity across keyring changes", async () => {
    await withDirectory(async (directory) => {
      const secured = await signer(directory, () => keyring()).identity();
      assert.deepEqual(await readdir(directory), ["desktop-free-identity.bin"]);
      assert.equal((await signer(directory, () => keyring()).identity()).publicKey, secured.publicKey);
      await assert.rejects(signer(directory, () => null).identity(), /keyring that is not available/);
    });
    await withDirectory(async (directory) => {
      const plain = await signer(directory, () => null).identity();
      assert.equal((await signer(directory, () => keyring()).identity()).publicKey, plain.publicKey);
      assert.deepEqual(await readdir(directory), ["desktop-free-identity.json"]);
    });
  });
});
