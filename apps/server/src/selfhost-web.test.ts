import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForUpdate,
  type FetchLike,
  compareSemver,
  engineInstallDir,
  isReleaseVersion,
  loadOrCreateWebTokens,
  opencodeReleaseAsset,
  opencodeGlobalConfigDir,
  opencodePluginDepsArchive,
  opencodeReleaseUrl,
  renameWithRetry,
  resolvePackageRoot,
  resolveWebRoot,
  seedOpencodePluginDeps,
} from "./selfhost-web.js";
import { parseCliArgs } from "./config.js";

describe("openwork-server web", () => {
  test("parses the web subcommand and its flags", () => {
    const args = parseCliArgs(["web", "--open", "--no-bootstrap-token", "--port", "9000"]);
    expect(args.web).toBe(true);
    expect(args.open).toBe(true);
    expect(args.bootstrapToken).toBe(false);
    expect(args.port).toBe(9000);
    expect(parseCliArgs(["--port", "9000"]).web).toBeUndefined();
  });

  test("maps platforms to release assets", () => {
    expect(opencodeReleaseAsset("darwin", "arm64")).toBe("opencode-darwin-arm64.zip");
    expect(opencodeReleaseAsset("linux", "x64")).toBe("opencode-linux-x64-baseline.tar.gz");
    expect(opencodeReleaseAsset("freebsd", "x64")).toBeNull();
    expect(opencodeReleaseUrl("v1.2.3", "a.zip")).toBe("https://github.com/anomalyco/opencode/releases/download/v1.2.3/a.zip");
    expect(engineInstallDir("/data", "1.2.3")).toBe("/data/engines/opencode-1.2.3");
  });

  test("compares versions and recognizes releases", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.10.0", "1.9.9")).toBe(1);
    expect(compareSemver("v0.18.49", "0.18.50")).toBe(-1);
    expect(isReleaseVersion("0.18.49")).toBe(true);
    expect(isReleaseVersion("0.0.0-dev")).toBe(false);
  });

  test("update check reports only newer releases and never throws", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ version: "0.19.0" }));
    expect(await checkForUpdate({ currentVersion: "0.18.0", env: {}, fetchImpl })).toBe("0.19.0");
    expect(await checkForUpdate({ currentVersion: "0.19.0", env: {}, fetchImpl })).toBeNull();
    expect(await checkForUpdate({ currentVersion: "0.0.0-dev", env: {}, fetchImpl })).toBeNull();
    expect(await checkForUpdate({ currentVersion: "0.18.0", env: { OPENWORK_NO_UPDATE_CHECK: "1" }, fetchImpl })).toBeNull();
    const failing: FetchLike = async () => { throw new Error("offline"); };
    expect(await checkForUpdate({ currentVersion: "0.18.0", env: {}, fetchImpl: failing })).toBeNull();
  });

  test("resolves the package root and web root from the launcher env or binary layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "ow-pkg-"));
    await mkdir(join(root, "web"), { recursive: true });
    await mkdir(join(root, "dist", "bin"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "web", "index.html"), "<html></html>");

    expect(await resolvePackageRoot({ env: { OPENWORK_PACKAGE_ROOT: root }, execPath: "/usr/bin/bun" })).toBe(root);
    expect(await resolvePackageRoot({ env: {}, execPath: join(root, "dist", "bin", "openwork-server") })).toBe(root);
    expect(await resolvePackageRoot({ env: {}, execPath: "/usr/bin/bun" })).toBeNull();

    expect(await resolveWebRoot({ env: {}, packageRoot: root, sourceDir: "/nowhere/src" })).toBe(join(root, "web"));
    const override = await mkdtemp(join(tmpdir(), "ow-web-"));
    await writeFile(join(override, "index.html"), "<html></html>");
    expect(await resolveWebRoot({ env: { OPENWORK_WEB_ROOT: override }, packageRoot: root, sourceDir: "/nowhere" })).toBe(override);
    expect(await resolveWebRoot({ env: {}, packageRoot: null, sourceDir: "/nowhere/src" })).toBeNull();
  });

  test("persists web tokens in the data dir and reuses them", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ow-data-"));
    const first = await loadOrCreateWebTokens({ env: {}, dataDir });
    expect(first.created).toBe(true);
    expect(first.token).toHaveLength(64);
    const second = await loadOrCreateWebTokens({ env: {}, dataDir });
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
    expect(second.hostToken).toBe(first.hostToken);
    expect(JSON.parse(await readFile(join(dataDir, "web-tokens.json"), "utf8")).token).toBe(first.token);
  });

  test("resolves OpenCode's global config folder like OpenCode does", () => {
    expect(opencodeGlobalConfigDir({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/u")).toBe(join("/x/cfg", "opencode"));
    expect(opencodeGlobalConfigDir({}, "/home/u")).toBe(join("/home/u", ".config", "opencode"));
    expect(opencodePluginDepsArchive("/pkg", "v1.18.30")).toBe(join("/pkg", "dist", "opencode-plugin-deps-1.18.30.tgz"));
  });

  test("seeds OpenCode's plugin dependencies only on a fresh profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-plugin-deps-"));
    const tree = join(root, "tree");
    await mkdir(join(tree, "node_modules", "@opencode-ai", "plugin"), { recursive: true });
    await writeFile(join(tree, "node_modules", "@opencode-ai", "plugin", "package.json"), '{"name":"@opencode-ai/plugin"}');
    await writeFile(join(tree, "package.json"), '{"dependencies":{"@opencode-ai/plugin":"1.0.0"}}');
    await writeFile(join(tree, "package-lock.json"), '{"packages":{"":{"dependencies":{"@opencode-ai/plugin":"1.0.0"}}}}');
    const archive = join(root, "opencode-plugin-deps-1.0.0.tgz");
    const packed = Bun.spawnSync(["tar", "-czf", archive, "-C", tree, "package.json", "package-lock.json", "node_modules"]);
    expect(packed.exitCode).toBe(0);

    const fresh = join(root, "fresh", "opencode");
    const seeded = await seedOpencodePluginDeps({ archive, configDir: fresh });
    expect(seeded.seeded).toBe(true);
    expect(await readFile(join(fresh, "node_modules", "@opencode-ai", "plugin", "package.json"), "utf8")).toContain("@opencode-ai/plugin");
    expect(await readFile(join(fresh, "package.json"), "utf8")).toContain("1.0.0");
    expect((await readdir(fresh)).sort()).toEqual(["node_modules", "package-lock.json", "package.json"]);

    // A profile OpenCode (or the user) already set up is left alone.
    const existing = join(root, "existing", "opencode");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "package.json"), '{"dependencies":{"left-pad":"1.3.0"}}');
    expect(await seedOpencodePluginDeps({ archive, configDir: existing })).toEqual({ seeded: false, reason: "already-set-up" });
    expect((await readdir(existing)).sort()).toEqual(["package.json"]);

    expect(await seedOpencodePluginDeps({ archive: join(root, "missing.tgz"), configDir: join(root, "a") }))
      .toEqual({ seeded: false, reason: "no-archive" });

    // A broken archive never throws and leaves nothing behind for OpenCode to trip on.
    const broken = join(root, "broken.tgz");
    await writeFile(broken, "not a tarball");
    const failedDir = join(root, "broken-profile", "opencode");
    const failed = await seedOpencodePluginDeps({ archive: broken, configDir: failedDir });
    expect(failed.seeded).toBe(false);
    expect(await readdir(failedDir)).toEqual([]);
  });

  test("retries the engine rename while Windows still holds the new binary", async () => {
    const busy = Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" });
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw busy;
    };
    await renameWithRetry("a.partial", "a", { platform: "win32", renameImpl: flaky, delaysMs: [0, 0, 0] });
    expect(calls).toBe(3);

    calls = 0;
    await expect(
      renameWithRetry("a.partial", "a", { platform: "win32", renameImpl: async () => { calls += 1; throw busy; }, delaysMs: [0, 0] }),
    ).rejects.toThrow("EBUSY");
    expect(calls).toBe(3);

    calls = 0;
    await expect(
      renameWithRetry("a.partial", "a", { platform: "darwin", renameImpl: async () => { calls += 1; throw busy; } }),
    ).rejects.toThrow("EBUSY");
    expect(calls).toBe(1);

    calls = 0;
    const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    await expect(
      renameWithRetry("a.partial", "a", { platform: "win32", renameImpl: async () => { calls += 1; throw missing; }, delaysMs: [0] }),
    ).rejects.toThrow("ENOENT");
    expect(calls).toBe(1);
  });
});
