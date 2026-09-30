import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPackagedNativeRuntime } from "../electron/packaged-native-runtime.mjs";
import nativeRuntime from "../native-runtime.json" with { type: "json" };

const dirnameHere = dirname(fileURLToPath(import.meta.url));
const coworkerRoot = resolve(dirnameHere, "..");
const repoRoot = resolve(coworkerRoot, "../..");
const sidecarDir = resolve(coworkerRoot, "resources", "sidecars");
const helperDir = resolve(coworkerRoot, "resources", "helpers");
const packagedServerRoot = resolve(coworkerRoot, "server");
const packagedElectronRoot = resolve(coworkerRoot, "electron-dist");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, cwd = repoRoot, env) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function stageNativeServer({ sourceDirectory = resolve(repoRoot, "apps/server/dist"), outputDirectory = packagedServerRoot } = {}) {
  const contains = (parent, child) => {
    const location = relative(resolve(parent), resolve(child));
    return !location || (!isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`));
  };
  if (contains(sourceDirectory, outputDirectory) || contains(outputDirectory, sourceDirectory)) throw new Error("Native server staging must be separate from the source build.");
  const serverPackage = JSON.parse(readFileSync(resolve(repoRoot, "apps/server/package.json"), "utf8"));
  const nodeOnlyDependencies = Object.fromEntries(Object.entries(serverPackage.dependencies).filter(([name]) =>
    !["@opencode-ai/sdk", "better-sqlite3", "drizzle-orm", "htmlparser2"].includes(name)));
  nodeOnlyDependencies["@openwork/paths"] = serverPackage.devDependencies["@openwork/paths"];
  if (!existsSync(resolve(sourceDirectory, "embedded-native.js"))) throw new Error("Build the native embedded server entry before staging Coworker.");
  rmSync(outputDirectory, { recursive: true, force: true });
  const target = resolve(outputDirectory, "dist");
  cpSync(sourceDirectory, target, { recursive: true });
  copyFileSync(resolve(repoRoot, "constants.json"), resolve(target, "constants.json"));
  // Relocate only Coworker's copy. Generic server/Desktop build output stays intact.
  for (const name of readdirSync(target).filter((name) => name.endsWith(".js"))) {
    const entry = resolve(target, name);
    const source = readFileSync(entry, "utf8");
    const packaged = source.replace(/from\s+["']\.\.\/\.\.\/\.\.\/constants\.json["']/g, 'from "./constants.json"');
    if (packaged !== source) writeFileSync(entry, packaged, "utf8");
  }
  writeFileSync(resolve(outputDirectory, "package.json"), `${JSON.stringify({
    name: "@openwork/coworker-runtime", version: serverPackage.version, private: true,
    type: "module", exports: { ".": "./dist/embedded-native.js" }, dependencies: nodeOnlyDependencies,
  }, null, 2)}\n`);
}

async function buildElectron() {
  run(pnpmCommand, ["--filter", "@openwork/automations", "build"]);
  run(pnpmCommand, ["--filter", "@openwork/headless-threads", "build"]);
  run(pnpmCommand, ["--filter", "openwork-server", "build"]);
  const { prepareNativeSourcePluginBundles } = await import("../electron/prepare-native-plugins.mjs");
  const { stageNativeSource } = await import("./build-native-source.mjs");
  const nativeBuild = await stageNativeSource({ resources: resolve(coworkerRoot, "resources"), prepareBundles: prepareNativeSourcePluginBundles, requireCached: Boolean(process.env.CSC_LINK || process.env.APPLE_API_KEY || process.env.MACOS_NOTARIZE === "true") });
  verifyPackagedNativeRuntime(resolve(coworkerRoot, "resources"));
  run(process.execPath, [
    resolve(repoRoot, "apps", "desktop", "scripts", "prepare-computer-use-helper.mjs"),
    "--force",
    "--outdir",
    helperDir,
  ], coworkerRoot);
  run(pnpmCommand, ["exec", "vite", "build"], coworkerRoot, { OPENWORK_ELECTRON_BUILD: "1" });

  rmSync(packagedElectronRoot, { recursive: true, force: true });
  mkdirSync(packagedElectronRoot, { recursive: true });
  copyFileSync(resolve(coworkerRoot, "native-runtime.json"), resolve(packagedElectronRoot, "native-runtime.json"));
  copyFileSync(resolve(coworkerRoot, "native-source.json"), resolve(packagedElectronRoot, "native-source.json"));
  writeFileSync(resolve(packagedElectronRoot, "OPENCODE-LICENSE"), nativeBuild.license);
  const { build } = await import("esbuild");
  const mainBuild = await build({ entryPoints: [resolve(coworkerRoot, "electron/main.mjs")], bundle: true, platform: "node", format: "esm", target: "node24",
    external: ["electron", "@modelcontextprotocol/sdk", "ws"], outfile: resolve(packagedElectronRoot, "main.mjs"), metafile: true,
    plugins: [{ name: "exclude-source-development-tools", setup(plugin) {
      plugin.onLoad({ filter: /[/\\]native-source-fixture\.mjs$/ }, () => ({ contents: 'export function readNativeSourceFixture() { throw new Error("Source fixtures are unavailable in packaged apps."); } export const prepareNativeSourceBundles = readNativeSourceFixture;', loader: "js" }));
    } }],
  });
  if (Object.keys(mainBuild.metafile.inputs).some((name) => /(?:node_modules\/(?:esbuild|typescript)|prepare-native-plugins\.mjs|build-native-source\.mjs)/.test(name.replaceAll("\\", "/")))) throw new Error("Source build tooling leaked into Electron main.");
  run(pnpmCommand, [
    "exec", "esbuild", resolve(coworkerRoot, "electron", "maintenance-helper.mjs"),
    "--bundle", "--platform=node", "--format=esm", "--target=node24",
    `--outfile=${resolve(packagedElectronRoot, "maintenance-helper.mjs")}`,
  ], coworkerRoot);
  copyFileSync(
    resolve(coworkerRoot, "electron", "preload.mjs"),
    resolve(packagedElectronRoot, "preload.mjs"),
  );
  copyFileSync(resolve(coworkerRoot, "electron", "bubble-preload.mjs"), resolve(packagedElectronRoot, "bubble-preload.mjs"));
  copyFileSync(fileURLToPath(import.meta.resolve("@openwork/browser-tabs/preload")), resolve(packagedElectronRoot, "browser-content-preload.cjs"));

  copyFileSync(resolve(repoRoot, "packages/browser-tabs/THIRD-PARTY-NOTICES"), resolve(packagedElectronRoot, "THIRD-PARTY-NOTICES"));
  stageNativeServer();

  for (const fileName of readdirSync(resolve(coworkerRoot, "electron")).filter((name) => name.endsWith(".mjs")).sort()) {
    run(process.execPath, ["--check", resolve(coworkerRoot, "electron", fileName)]);
  }
  run(process.execPath, ["--check", resolve(packagedElectronRoot, "main.mjs")]);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    renderer: "apps/coworker/dist",
    electronMain: "apps/coworker/electron-dist/main.mjs",
    server: "apps/coworker/server/dist/embedded-native.js",
    sidecars: "apps/coworker/resources/sidecars",
    nativePlugins: "apps/coworker/resources/native-plugins",
    computerUseHelper: process.platform === "darwin" ? "apps/coworker/resources/helpers/OpenWork Computer Use.app" : null,
  }, null, 2)}\n`);
}

// pnpm 11 makes list recursive in workspaces even with --recursive=false.
// Scope roots before the collector starts; keep the complete dependency depth.
export async function beforePack(context) {
  const { lstatSync } = await import("node:fs");
  process.env.pnpm_config_filter = "@openwork/coworker";
  const platform = context.electronPlatformName;
  const targetArch = { 1: "x64", 3: "arm64", x64: "x64", arm64: "arm64" }[context.arch];
  if (!["darwin", "win32", "linux"].includes(platform) || !targetArch) {
    throw new Error(`Unsupported Coworker sidecar target: ${platform}/${context.arch}`);
  }
  const projectDir = context.packager.projectDir;
  const staging = resolve(projectDir, "resources/sidecars");
  const engine = platform === "win32" ? "opencode2.exe" : "opencode2";
  for (const name of [engine, "versions.json"]) {
    const stat = lstatSync(resolve(staging, name), { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size === 0) throw new Error(`Missing nonempty Coworker native target resource: ${name}`);
  }
  const runtime = JSON.parse(readFileSync(resolve(projectDir, "native-runtime.json"), "utf8"));
  if (runtime.opencodeV2Version !== nativeRuntime.opencodeV2Version) throw new Error("The development native pin must remain separate from the packaged source profile.");
  verifyPackagedNativeRuntime(resolve(projectDir, "resources"), { platform, arch: targetArch });
  // Select before copying, including repeated targets; never prune shared staging.
  const config = context.packager.config;
  for (const scope of [config, config[{ darwin: "mac", win32: "win", linux: "linux" }[platform]]]) {
    if (!scope?.extraResources) continue;
    const resources = Array.isArray(scope.extraResources) ? scope.extraResources : [scope.extraResources];
    scope.extraResources = resources.filter((resource) => {
      const destination = typeof resource === "string" ? resource : resource.to ?? resource.from;
      return !destination?.replaceAll("\\", "/").split("/").some((part) => part === "sidecars" || part === "opencode-plugins");
    });
  }
  config.extraResources = [
    ...(config.extraResources ?? []),
    // Directory copying retains Windows executable-signing transformations;
    // electron-builder's single-file fast path bypasses that transformer.
    { from: staging, to: "sidecars", filter: [engine, "versions.json", "native-receipt.json"] },
  ];
}

// electron-builder imports this hook without running the build. Desktop's full
// after-pack hook assumes its .electron-runtime tree, which Coworker does not use.
export default function afterPack(context, { runNative = spawnSync } = {}) {
  if (context.electronPlatformName !== "darwin") return;
  const architectures = {
    1: ["x86_64"], 3: ["arm64"], 4: ["x86_64", "arm64"],
    x64: ["x86_64"], arm64: ["arm64"], universal: ["x86_64", "arm64"],
  }[context.arch];
  if (!Array.isArray(architectures)) throw new Error(`Computer Use does not support the macOS package architecture: ${context.arch}`);
  const helperApp = resolve(context.appOutDir, `${context.packager.appInfo.productFilename}.app`,
    "Contents", "Resources", "helpers", "OpenWork Computer Use.app");
  const executable = resolve(helperApp, "Contents", "MacOS", "ComputerUse");
  if (!existsSync(executable)) throw new Error(`Missing packaged Computer Use helper: ${executable}`);
  const plist = readFileSync(resolve(helperApp, "Contents", "Info.plist"), "utf8");
  if (!/<key>CFBundleIdentifier<\/key>\s*<string>com\.differentai\.openwork\.computer-use<\/string>/.test(plist)) {
    throw new Error("The Computer Use helper must retain its shared native bundle identity.");
  }
  // Until #4512's target-aware generator lands, --outdir still builds for the
  // host CPU. Fail closed on the actual builder target, not TARGET or process.arch.
  const cpu = runNative("/usr/bin/lipo", [executable, "-verify_arch", ...architectures], { encoding: "utf8", timeout: 10_000 });
  if (cpu.error || cpu.status !== 0) {
    throw new Error(`The packaged Computer Use helper does not contain ${architectures.join(" and ")}. Build on the target Mac architecture; cross-CPU packaging is not supported by the current helper generator.`);
  }
  // The generator signs the bundle; electron-builder subsequently signs nested
  // apps. Desktop's shared afterSign hook verifies its distribution signature.
  const signature = runNative("/usr/bin/codesign", ["--verify", "--deep", "--strict", helperApp], { encoding: "utf8", timeout: 10_000 });
  if (signature.error || signature.status !== 0) throw new Error("The packaged Computer Use helper signature is invalid.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildElectron();
