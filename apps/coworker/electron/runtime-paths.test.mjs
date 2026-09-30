import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import YAML from "yaml";
import { resolveBundledOpencodeV2Binary, resolveUserDataDir } from "./runtime-paths.mjs";
import { beforePack, stageNativeServer } from "../scripts/electron-build.mjs";
import nativeRuntime from "../native-runtime.json" with { type: "json" };
import { NATIVE_PLUGIN_DEPENDENCIES, NATIVE_PLUGIN_FILES, configureNativePluginBundles, verifyNativePluginBundles, validateNativePluginManifest } from "./native-plugin.mjs";
import { nativeSource, nativeTarget, sha256, validateSourceReceipt, verifyPackagedNativeRuntime } from "./packaged-native-runtime.mjs";
import { sign } from "../scripts/sign-native-source.mjs";

function nativeBytes(platform, arch) {
  const bytes = Buffer.alloc(128);
  if (platform === "darwin") { bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(arch === "arm64" ? 0x100000c : 0x1000007, 4); }
  if (platform === "linux") { bytes.set([127, 69, 76, 70, 2, 1]); bytes.writeUInt16LE(arch === "arm64" ? 183 : 62, 18); }
  if (platform === "win32") { bytes.write("MZ"); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 68); }
  return bytes;
}

async function syntheticNative(resources, platform = "linux", arch = "x64") {
  const write = async (file, bytes) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); };
  const binary = nativeBytes(platform, arch);
  const files = Object.fromEntries(["schema/dist/tool.d.ts", "plugin/dist/effect/tool.d.ts", "plugin/dist/promise/tool.d.ts", "sdk/dist/tool.d.ts", "sdk/dist/effect/tool.d.ts"].map((file) => [file, sha256("synthetic SDK")]));
  const receipt = { format: "coworker-native-build/v1", source: nativeSource, version: nativeSource.version, platform, arch, target: nativeTarget(platform, arch),
    binary: { sha256: sha256(binary), unsignedSha256: sha256(binary), bytes: binary.length }, sdk: { sha256: sha256(JSON.stringify(files)), files } };
  const bytes = Buffer.from("export default {};\n");
  const entries = {};
  for (const name of NATIVE_PLUGIN_FILES) {
    const file = name.replace(/\.js$/, ".mjs");
    await write(path.join(resources, "native-plugins", file), bytes);
    entries[name] = { file, bytes: bytes.length, sha256: sha256(bytes) };
  }
  const manifest = { format: "coworker-native-source-plugins/v1", opencodeVersion: nativeSource.version, executableSha256: receipt.binary.sha256,
    sdkSourceDiffSha256: nativeSource.patchSha256, sdkSha256: receipt.sdk.sha256, dependencies: { "@opencode/plugin": "2.0.5", "@opencode/schema": "2.0.5" }, entries };
  const manifestBytes = JSON.stringify(manifest);
  receipt.pluginsSha256 = sha256(manifestBytes);
  await write(path.join(resources, "sidecars", platform === "win32" ? "opencode2.exe" : "opencode2"), binary);
  await write(path.join(resources, "sidecars/versions.json"), JSON.stringify({ opencode2: { version: nativeSource.version, platform, arch } }));
  await write(path.join(resources, "sidecars/native-receipt.json"), JSON.stringify(receipt));
  await write(path.join(resources, "native-plugins/manifest.json"), manifestBytes);
  return { receipt, manifest, bytes, sourceBuild: { version: receipt.version, sha256: receipt.binary.sha256 } };
}

test("native compile uses virtual CommonJS locations and embedded resources after source removal", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "coworker-portable-compile-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const patch = fileURLToPath(new URL(`../../../${nativeSource.patch}`, import.meta.url));
  assert.equal(sha256(await readFile(patch)), nativeSource.patchSha256);
  const applied = spawnSync("git", ["apply", "--include=packages/cli/script/portable-paths.ts", patch], { cwd: root, encoding: "utf8" });
  assert.equal(applied.status, 0, applied.stderr);
  const version = spawnSync("bun", ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), nativeSource.bunVersion);
  const source = path.join(root, "source");
  await mkdir(source);
  const modules = ["typescript/lib/typescript.js", "@npmcli/run-script/lib/set-path.js", "@npmcli/arborist/lib/debug.js", "write-file-atomic/lib/index.js", "@silvia-odwyer/photon-node/photon_rs.js"];
  for (const name of modules) {
    const file = path.join(source, "node_modules", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "module.exports = {directory: __dirname, filename: __filename};");
  }
  await writeFile(path.join(source, "payload.txt"), "portable resource");
  const entry = path.join(source, "entry.mjs");
  await writeFile(entry, `${modules.map((name, index) => `import p${index} from ${JSON.stringify(`./node_modules/${name}`)};`).join("\n")}\nimport file from "./payload.txt" with {type:"file"};\nconsole.log(JSON.stringify({locations:[p0,p1,p2,p3,p4],payload:await Bun.file(file).text()}));`);
  const compile = path.join(root, "compile.mjs");
  await writeFile(compile, `import {portablePathsPlugin} from ${JSON.stringify(pathToFileURL(path.join(root, "packages/cli/script/portable-paths.ts")).href)};\nfor (const portable of [false,true]) { const result = await Bun.build({entrypoints:[${JSON.stringify(entry)}],format:"esm",minify:true,bytecode:true,sourcemap:"none",compile:{outfile:${JSON.stringify(root)}+"/"+(portable?"portable":"original")},plugins:portable?[portablePathsPlugin]:[]}); if(!result.success) throw new Error("Compile regression failed"); }`);
  const built = spawnSync("bun", [compile], { encoding: "utf8", timeout: 60_000 });
  assert.equal(built.status, 0, built.stderr);
  await rename(source, path.join(root, "removed-source"));
  for (const portable of [false, true]) {
    const binary = path.join(root, `${portable ? "portable" : "original"}${process.platform === "win32" ? ".exe" : ""}`);
    const bytes = await readFile(binary);
    const retained = [source, source.replaceAll("\\", "/")].some((location) => bytes.includes(Buffer.from(location)));
    assert.equal(retained, !portable, "The control must retain the host path; the corrected compile must not.");
    const run = spawnSync(binary, [], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.payload, "portable resource");
    if (portable) for (const location of result.locations) {
      assert.ok(location.filename.replaceAll("\\", "/").includes("/$bunfs/") || location.filename.replaceAll("\\", "/").includes("/~BUN/"), "Locations must resolve to Bun's runtime filesystem, not placeholder text.");
      assert.equal(location.directory, path.dirname(location.filename));
    }
  }
});

test("packaging selects only the pinned native target without changing staging and rejects invalid inputs", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-sidecars-"));
  const projectDir = path.join(root, "apps/coworker");
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousFilter = process.env.pnpm_config_filter;
  t.after(() => {
    if (previousFilter === undefined) delete process.env.pnpm_config_filter;
    else process.env.pnpm_config_filter = previousFilter;
  });
  const staging = path.join(projectDir, "resources/sidecars");
  await mkdir(staging, { recursive: true });
  const constants = JSON.parse(await readFile(new URL("../../../constants.json", import.meta.url), "utf8"));
  assert.equal(constants.opencodeV2Version, "0.0.0-beta-19086", "Desktop retains its own optional-v2 pin");
  assert.equal(nativeRuntime.opencodeV2Version, "0.0.0-beta-19271");
  await writeFile(path.join(root, "constants.json"), JSON.stringify(constants));
  await writeFile(path.join(projectDir, "native-runtime.json"), JSON.stringify(nativeRuntime));
  const files = ["opencode", "opencode-aarch64-apple-darwin", "versions.json-aarch64-apple-darwin", "opencode2", "opencode2.exe", "versions.json", "native-receipt.json"];
  for (const name of files) await writeFile(path.join(staging, name), name);
  await mkdir(path.join(staging, ".verified-v2"));
  await writeFile(path.join(staging, ".verified-v2/cache"), "retain staging cache");
  const config = YAML.parse(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  const plugins = config.extraResources.find((resource) => resource.to === "native-plugins");
  assert.ok(plugins);
  const helpers = structuredClone(config.mac.extraResources);
  config.extraResources.push({ from: "server/dist/opencode-plugins", to: "opencode-plugins" });
  const packager = { projectDir, config };
  const metadataFile = path.join(staging, "versions.json");
  const metadata = (platform, arch) => ({ opencode2: { version: nativeSource.version, platform, arch } });
  const snapshot = async () => Promise.all(files.map((name) => readFile(path.join(staging, name), "utf8")));
  for (const [electronPlatformName, arch, targetArch] of [["darwin", 3, "arm64"], ["win32", 1, "x64"], ["linux", "x64", "x64"]]) {
    await syntheticNative(path.join(projectDir, "resources"), electronPlatformName, targetArch);
    const before = await snapshot();
    await beforePack({ packager, electronPlatformName, arch });
    assert.equal(process.env.pnpm_config_filter, "@openwork/coworker");
    assert.deepEqual(packager.config.extraResources, [plugins,
      { from: staging, to: "sidecars", filter: [electronPlatformName === "win32" ? "opencode2.exe" : "opencode2", "versions.json", "native-receipt.json"] },
    ]);
    assert.deepEqual(await snapshot(), before);
  }
  assert.deepEqual(config.mac.extraResources, helpers);
  await syntheticNative(path.join(projectDir, "resources"), "darwin", "arm64");
  const context = { packager, electronPlatformName: "darwin", arch: 3 };
  const selected = structuredClone(config.extraResources);
  for (const invalid of [
    { opencode2: { ...metadata("darwin", "arm64").opencode2, version: constants.opencodeV2Version } },
    { opencode2: { ...metadata("darwin", "arm64").opencode2, version: "0.0.0-beta-stale" } },
    metadata("win32", "arm64"), metadata("darwin", "x64"), {},
    { ...metadata("darwin", "arm64"), opencode: { version: "v1.18.18" } },
  ]) {
    await writeFile(metadataFile, JSON.stringify(invalid));
    await assert.rejects(beforePack(context), /version metadata does not match/);
    assert.deepEqual(config.extraResources, selected, "invalid staging must not change resource selection");
  }
  await writeFile(metadataFile, JSON.stringify(metadata("darwin", "arm64")));
  await writeFile(path.join(projectDir, "native-runtime.json"), JSON.stringify(constants));
  await assert.rejects(beforePack(context), /development native pin/);
  assert.deepEqual(config.extraResources, selected);
  await writeFile(path.join(projectDir, "native-runtime.json"), JSON.stringify(nativeRuntime));
  await writeFile(metadataFile, "{");
  await assert.rejects(beforePack(context), SyntaxError);
  await rm(metadataFile);
  await assert.rejects(beforePack(context), /Missing nonempty.*versions.json/);
  await writeFile(metadataFile, JSON.stringify(metadata("darwin", "arm64")));
  await writeFile(path.join(staging, "opencode2"), "");
  await assert.rejects(beforePack(context), /Missing nonempty.*opencode2/);
  await rm(path.join(staging, "opencode2"));
  await assert.rejects(beforePack(context), /Missing nonempty.*opencode2/);
  await symlink(path.join(staging, "opencode2.exe"), path.join(staging, "opencode2"));
  await assert.rejects(beforePack(context), /Missing nonempty.*opencode2/);
  await assert.rejects(beforePack({ ...context, arch: 4 }), /Unsupported Coworker sidecar target/);
  await assert.rejects(beforePack({ ...context, electronPlatformName: "freebsd" }), /Unsupported Coworker sidecar target/);
  assert.deepEqual((await readdir(staging)).sort(), [...files, ".verified-v2"].sort());
  assert.equal(await readFile(path.join(staging, ".verified-v2/cache"), "utf8"), "retain staging cache");
});

test("synthetic release validation keeps the Coworker pin separate from packaged Desktop defaults", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-release-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const app = path.join(root, "linux-unpacked");
  const resources = path.join(app, "resources");
  const write = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };
  const constants = JSON.parse(await readFile(new URL("../../../constants.json", import.meta.url), "utf8"));
  await write(path.join(source, "package.json"), '{"private":true}');
  for (const file of ["dist/index.html", "electron-dist/main.mjs", "electron-dist/preload.mjs", "electron-dist/bubble-preload.mjs", "electron-dist/browser-content-preload.cjs",
    "electron-dist/maintenance-helper.mjs", "electron-dist/THIRD-PARTY-NOTICES", "electron-dist/OPENCODE-LICENSE"]) await write(path.join(source, file), "fixture");
  const serverDist = path.join(root, "shared-server-dist");
  const sharedModule = 'import constants from "../../../constants.json" with { type: "json" };\nexport { constants };\n';
  await write(path.join(serverDist, "embedded.js"), sharedModule);
  await write(path.join(serverDist, "embedded-native.js"), 'export { startEmbeddedServer } from "./embedded.js";\n');
  stageNativeServer({ sourceDirectory: serverDist, outputDirectory: path.join(source, "server") });
  assert.equal(await readFile(path.join(serverDist, "embedded.js"), "utf8"), sharedModule, "staging must not mutate Desktop's server build");
  assert.match(await readFile(path.join(source, "server/dist/embedded.js"), "utf8"), /from "\.\/constants\.json"/);
  const nativePackage = JSON.parse(await readFile(path.join(source, "server/package.json"), "utf8"));
  assert.equal(nativePackage.exports["."], "./dist/embedded-native.js");
  assert.equal(nativePackage.bin, undefined);
  for (const name of ["@opencode-ai/sdk", "opencode-chrome-devtools", "drizzle-orm", "better-sqlite3"]) assert.equal(nativePackage.dependencies[name], undefined);
  assert.equal(nativePackage.dependencies["@openwork/paths"], "workspace:*");
  assert.throws(() => stageNativeServer({ sourceDirectory: serverDist, outputDirectory: root }), /separate from the source build/);
  assert.equal(await readFile(path.join(serverDist, "embedded.js"), "utf8"), sharedModule);
  const runtimeFile = path.join(source, "electron-dist/native-runtime.json");
  await write(runtimeFile, JSON.stringify(nativeRuntime));
  await write(path.join(source, "electron-dist/native-source.json"), JSON.stringify(nativeSource));
  const { manifest, bytes, sourceBuild } = await syntheticNative(resources);
  const metadataFile = path.join(resources, "sidecars/versions.json");
  const metadata = { opencode2: { version: nativeSource.version, platform: "linux", arch: "x64" } };
  const manifestFile = path.join(resources, "native-plugins/manifest.json");
  configureNativePluginBundles(path.join(resources, "native-plugins"), { sourceBuild });
  await verifyNativePluginBundles();
  for (const alter of [
    (value) => { delete value.entries["auto-memory.js"]; },
    (value) => { delete value.entries["fast-decision.js"]; },
    (value) => { delete value.entries["coworker-events.js"]; },
    (value) => { delete value.entries["coworker-abilities.js"]; },
    (value) => { value.dependencies.unpinned = "*"; },
    (value) => { value.entries["coworker-browser.js"].bytes++; },
  ]) {
    const invalid = structuredClone(manifest);
    alter(invalid);
    await write(manifestFile, JSON.stringify(invalid));
    await assert.rejects(verifyNativePluginBundles(), /manifest|declaration|integrity/);
  }
  await write(manifestFile, JSON.stringify(manifest));
  const browserBundle = path.join(resources, "native-plugins/coworker-browser.mjs");
  await write(browserBundle, "tampered source");
  await assert.rejects(verifyNativePluginBundles(), /integrity/);
  await rm(browserBundle);
  await assert.rejects(verifyNativePluginBundles(), /ENOENT/);
  await write(browserBundle, bytes);
  await verifyNativePluginBundles();
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const libraryRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  const asar = libraryRequire("@electron/asar");
  const validate = async () => {
    await finished(await asar.createPackage(source, path.join(resources, "app.asar")));
    return spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/release-size.mjs", import.meta.url)),
      app, "--check", "--platform", "linux", "--arch", "x64"], { encoding: "utf8", timeout: 10_000 });
  };
  const accepted = await validate();
  assert.equal(accepted.status, 0, accepted.stderr);
  const bubblePreload = path.join(source, "electron-dist/bubble-preload.mjs");
  await rm(bubblePreload);
  const missingBubble = await validate();
  assert.equal(missingBubble.status, 1);
  assert.match(missingBubble.stderr, /Missing nonempty ASAR runtime entry: electron-dist\/bubble-preload\.mjs/);
  await write(bubblePreload, "fixture");
  await write(path.join(source, "electron-dist/main.mjs"), fileURLToPath(new URL("../../../", import.meta.url)));
  const leakedSource = await validate();
  assert.equal(leakedSource.status, 1);
  assert.match(leakedSource.stderr, /private source build path/);
  await write(path.join(source, "electron-dist/main.mjs"), "fixture");
  await write(runtimeFile, JSON.stringify({ opencodeV2Version: constants.opencodeV2Version }));
  const staleRuntime = await validate();
  assert.equal(staleRuntime.status, 1);
  assert.match(staleRuntime.stderr, /packaged Coworker runtime must match pin/);
  await write(runtimeFile, JSON.stringify(nativeRuntime));
  await write(metadataFile, JSON.stringify({ opencode2: { ...metadata.opencode2, version: constants.opencodeV2Version } }));
  const staleSidecar = await validate();
  assert.equal(staleSidecar.status, 1);
  assert.match(staleSidecar.stderr, /packaged Coworker runtime must match pin/);
});

test("source receipts reject swapped inputs and bundles while default beta manifests remain valid", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-source-receipts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { receipt, manifest } = await syntheticNative(root);
  const options = { platform: "linux", arch: "x64" };
  assert.equal(verifyPackagedNativeRuntime(root, options).sourceBuild.version, nativeSource.version);
  const beta = { format: "coworker-native-plugins/v1", opencodeVersion: nativeRuntime.opencodeV2Version, dependencies: NATIVE_PLUGIN_DEPENDENCIES, entries: manifest.entries };
  assert.equal(validateNativePluginManifest(beta), beta);
  for (const mutate of [
    (value) => { value.source.commit = "0".repeat(40); },
    (value) => { value.source.patchSha256 = "0".repeat(64); },
    (value) => { value.source.bunVersion = "1.3.10"; },
    (value) => { value.source.sdkVersion = "2.0.4"; },
    (value) => { value.version = nativeRuntime.opencodeV2Version; },
    (value) => { value.target = "opencode-linux-arm64"; },
    (value) => { value.arch = "arm64"; },
    (value) => { value.sdk.files["sdk/dist/tool.d.ts"] = "0".repeat(64); },
    (value) => { delete value.sdk.files["schema/dist/tool.d.ts"]; },
    (value) => { value.sdk.files["schema/dist/../../outside.js"] = "0".repeat(64); },
  ]) {
    const invalid = structuredClone(receipt);
    mutate(invalid);
    assert.throws(() => validateSourceReceipt(invalid, "linux", "x64"), /receipt/);
  }
  const binaryFile = path.join(root, "sidecars/opencode2");
  await writeFile(binaryFile, nativeBytes("linux", "arm64"));
  assert.throws(() => verifyPackagedNativeRuntime(root, options), /SHA-256/);
  const invalid = structuredClone(receipt);
  invalid.binary.sha256 = sha256(nativeBytes("linux", "arm64"));
  await writeFile(path.join(root, "sidecars/native-receipt.json"), JSON.stringify(invalid));
  assert.throws(() => verifyPackagedNativeRuntime(root, options), /target header/);
  await syntheticNative(root);
  await writeFile(path.join(root, "native-plugins/coworker-browser.mjs"), "swapped bundle");
  assert.throws(() => verifyPackagedNativeRuntime(root, options), /plugin failed SHA-256/);
  await syntheticNative(root);
  await writeFile(path.join(root, "native-plugins/manifest.json"), JSON.stringify({ ...manifest, sdkSha256: "0".repeat(64) }));
  assert.throws(() => verifyPackagedNativeRuntime(root, options), /manifest failed SHA-256/);
  await syntheticNative(root);
  await writeFile(path.join(root, "native-plugins/extra.mjs"), "extra");
  assert.throws(() => verifyPackagedNativeRuntime(root, options), /Unexpected/);
});

test("macOS signing binds the signed engine receipt before sealing the app and retains default signing", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-source-signing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "Open Coworker.app");
  const resources = path.join(app, "Contents/Resources");
  const { receipt } = await syntheticNative(resources, "darwin", process.arch);
  const bin = path.join(resources, "sidecars/opencode2");
  const original = await readFile(bin);
  let signedApp = false;
  const calls = [];
  await sign({ app, identity: "synthetic-identity", platform: "darwin", keychain: "synthetic-keychain", optionsForFile: () => ({ hardenedRuntime: true, entitlements: "synthetic.plist" }), ignore: (file) => file.endsWith(".kext") }, {}, {
    runCodesign: (args) => { calls.push(args); if (args.includes("--force")) { const changed = Buffer.from(original); changed[100] = 1; const require = createRequire(import.meta.url); require("node:fs").writeFileSync(bin, changed); } },
    signApp: async (options) => {
      const verified = verifyPackagedNativeRuntime(resources);
      assert.notEqual(verified.sourceBuild.sha256, receipt.binary.sha256);
      assert.equal(verified.receipt.binary.unsignedSha256, receipt.binary.sha256);
      assert.equal(options.identity, "synthetic-identity");
      assert.equal(options.ignore(bin), true);
      assert.equal(options.ignore("driver.kext"), true);
      assert.equal(options.ignore(app), false);
      signedApp = true;
    },
  });
  assert.equal(signedApp, true);
  assert.ok(calls[0].includes("--timestamp"));
  assert.deepEqual(calls.at(-1), ["--verify", "--deep", "--strict", app]);
});

test("native runtime resolution prefers packaged resources and never falls back to v1", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const name = platform === "win32" ? "opencode2.exe" : "opencode2";
    const packaged = path.join("/package/resources/sidecars", name);
    const development = path.join("/source/resources/sidecars", name);
    const files = new Set([packaged, development, "/package/resources/sidecars/opencode", "/package/resources/sidecars/opencode-aarch64-apple-darwin"]);
    const options = { platform, appRoot: "/source", resourcesPath: "/package/resources", fileExists: (file) => files.has(file) };
    assert.equal(resolveBundledOpencodeV2Binary(options), packaged);
    assert.equal(resolveBundledOpencodeV2Binary({ ...options, isPackaged: true }), packaged);
    files.delete(packaged);
    assert.throws(() => resolveBundledOpencodeV2Binary({ ...options, isPackaged: true }), /packaged native engine is missing/);
    assert.equal(resolveBundledOpencodeV2Binary(options), development);
    files.delete(development);
    assert.equal(resolveBundledOpencodeV2Binary(options), null);
  }
});

test("uninstall preserves the person's app data", async () => {
  const config = YAML.parse(await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
});

test("isolated profiles win over the default userData location, app override first", () => {
  const appDataDir = "/Users/me/Library/Application Support";
  assert.equal(
    resolveUserDataDir({ env: {}, appDataDir, appIdentifier: "com.differentai.opencoworker" }),
    path.join(appDataDir, "com.differentai.opencoworker"),
  );
  assert.equal(
    resolveUserDataDir({ env: { OPENWORK_ELECTRON_USERDATA: "/tmp/profile/electron-userdata" }, appDataDir, appIdentifier: "x" }),
    "/tmp/profile/electron-userdata",
  );
  assert.equal(
    resolveUserDataDir({
      env: { COWORKER_USER_DATA_DIR: "/tmp/coworker-profile", OPENWORK_ELECTRON_USERDATA: "/tmp/profile/electron-userdata" },
      appDataDir,
      appIdentifier: "x",
    }),
    "/tmp/coworker-profile",
  );
  assert.equal(resolveUserDataDir({ env: { COWORKER_USER_DATA_DIR: "   " }, appDataDir, appIdentifier: "y" }), path.join(appDataDir, "y"));
});
