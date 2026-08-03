import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Could not read ${path}: ${error.message}`);
  }
}

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag) {
  fail("Usage: npm run release:check -- vMAJOR.MINOR.PATCH");
}

const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
if (!match) {
  fail(`Release tag must use stable semantic versioning (for example v0.1.3), received: ${tag}`);
}

const expectedVersion = match.slice(1).join(".");
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");

const cargoResult = spawnSync(
  "cargo",
  [
    "metadata",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--no-deps",
    "--format-version",
    "1",
    "--locked",
  ],
  { encoding: "utf8" },
);

if (cargoResult.error) {
  fail(`Could not run Cargo metadata: ${cargoResult.error.message}`);
}
if (cargoResult.status !== 0) {
  fail(cargoResult.stderr.trim() || "Cargo metadata failed.");
}

let cargoMetadata;
try {
  cargoMetadata = JSON.parse(cargoResult.stdout);
} catch (error) {
  fail(`Could not parse Cargo metadata: ${error.message}`);
}

const cargoPackage = cargoMetadata.packages.find(
  (item) => item.name === "luma-palette-csp",
);
if (!cargoPackage) {
  fail("Cargo metadata did not contain the luma-palette-csp package.");
}

const declaredVersions = [
  ["package.json", packageJson.version],
  ["package-lock.json", packageLock.version],
  ["package-lock.json root package", packageLock.packages?.[""]?.version],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["src-tauri/Cargo.toml", cargoPackage.version],
];

const mismatches = declaredVersions.filter(([, version]) => version !== expectedVersion);
if (mismatches.length > 0) {
  console.error(`Release version ${expectedVersion} does not match every version source:`);
  for (const [source, version] of mismatches) {
    console.error(`  ${source}: ${version ?? "missing"}`);
  }
  process.exit(1);
}

console.log(`Release version ${expectedVersion} matches every version source.`);
