#!/usr/bin/env node
// Prepares an EveryApp app repository (for example one cloned from oss.new) so it
// installs on anyone's Gateway: pins @every-app/sdk and everyapp to one exact npm
// version, adds the Release workflow, and refreshes the lockfile.
//
// Usage: node prepare.mjs <app-dir> [--version <x.y.z>] [--dry-run] [--no-install]
// Zero dependencies, Node 22+. Safe to run again: a second run changes nothing.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = "Usage: node prepare.mjs <app-dir> [--version <x.y.z>] [--dry-run] [--no-install]";
const SDK = "@every-app/sdk";
const CLI = "everyapp";
// Where each package goes when the app doesn't list it yet.
const USUAL_SECTION = { [SDK]: "dependencies", [CLI]: "devDependencies" };
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const RELEASE_EXCLUDES = ["everyapp", "'@every-app/*'"];
const TARBALL = "everyapp-release.tar.gz";
const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "templates", "release.yml");

function fail(message) {
  console.error(`prepare: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) fail(`needs Node 22 or newer (this is ${process.version}).`);

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "no-install": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (error) {
  fail(`${error.message}\n${USAGE}`);
}
if (parsed.values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (parsed.positionals.length !== 1) fail(`give exactly one app directory.\n${USAGE}`);

const appDir = path.resolve(parsed.positionals[0]);
const dryRun = parsed.values["dry-run"];
const skipInstall = parsed.values["no-install"];

if (!fs.existsSync(appDir)) fail(`${appDir} does not exist.`);
if (!fs.existsSync(path.join(appDir, "everyapp.config.ts"))) {
  fail(`${appDir} has no everyapp.config.ts, so it is not an EveryApp app. Nothing changed.`);
}
const packageJsonPath = path.join(appDir, "package.json");
if (!fs.existsSync(packageJsonPath)) fail(`${appDir} has no package.json. Nothing changed.`);

// ---------------------------------------------------------------------------
// The version to pin: --version, or npm's latest everyapp. Both packages must exist at it.
// ---------------------------------------------------------------------------

async function npmVersionExists(name, version) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`);
  if (response.status === 404) return false;
  if (!response.ok) fail(`npm registry answered ${response.status} for ${name}@${version}. Try again.`);
  return true;
}

async function npmLatest(name) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`);
  if (!response.ok) fail(`could not read the latest ${name} from npm (HTTP ${response.status}).`);
  return (await response.json()).version;
}

let version = parsed.values.version;
if (version === undefined) {
  version = await npmLatest(CLI);
} else if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`--version takes an exact version like 0.4.2, not "${version}".`);
}
for (const name of [SDK, CLI]) {
  if (!(await npmVersionExists(name, version))) fail(`${name}@${version} is not on npm. Pick a version both packages have.`);
}

// ---------------------------------------------------------------------------
// Work out every change first, then write them (or only print them with --dry-run).
// ---------------------------------------------------------------------------

const changes = []; // what we changed, for the summary
const warnings = []; // what the person or agent must look at
const notes = []; // good to know, nothing to fix

// 1. package.json: pin both packages, in whichever section they already are.
const packageJsonText = fs.readFileSync(packageJsonPath, "utf8");
const manifest = JSON.parse(packageJsonText);
for (const name of [SDK, CLI]) {
  const sections = DEPENDENCY_SECTIONS.filter((section) => manifest[section]?.[name] !== undefined);
  if (sections.length === 0) {
    const section = USUAL_SECTION[name];
    manifest[section] = { ...(manifest[section] ?? {}), [name]: version };
    changes.push(`package.json: added ${name} ${version} to ${section}`);
    continue;
  }
  for (const section of sections) {
    const current = manifest[section][name];
    if (current === version) continue;
    manifest[section][name] = version;
    changes.push(`package.json: ${section}.${name} "${current}" -> "${version}"`);
  }
}
const indent = /\n([ \t]+)"/.exec(packageJsonText)?.[1] ?? 2;
const newPackageJsonText = `${JSON.stringify(manifest, null, indent)}\n`;
const packageJsonChanged = newPackageJsonText !== packageJsonText;

const overrides = { ...manifest.overrides, ...manifest.pnpm?.overrides, ...manifest.resolutions };
for (const [name, spec] of Object.entries(overrides)) {
  if ((name.startsWith("@every-app/") || name === CLI) && /^(link|file|workspace):/.test(String(spec))) {
    warnings.push(`package.json overrides ${name} with "${spec}". Remove that entry, then run this again.`);
  }
}

// 2. pnpm-workspace.yaml: with minimumReleaseAge, exclude our packages so a fresh release installs.
const workspacePath = path.join(appDir, "pnpm-workspace.yaml");
let workspaceText = fs.existsSync(workspacePath) ? fs.readFileSync(workspacePath, "utf8") : null;
let workspaceChanged = false;
if (workspaceText !== null) {
  const result = addReleaseAgeExcludes(workspaceText);
  if (result.warning) warnings.push(result.warning);
  if (result.text !== workspaceText) {
    workspaceText = result.text;
    workspaceChanged = true;
    changes.push(`pnpm-workspace.yaml: minimumReleaseAgeExclude now lists ${result.added.join(", ")}`);
  }
  for (const line of workspaceText.split("\n")) {
    if (/(every-?app)/i.test(line) && /(link|file):/.test(line)) {
      warnings.push(`pnpm-workspace.yaml has "${line.trim()}" (a local link). Remove it, then run this again.`);
    }
  }
}

/**
 * Adds everyapp and '@every-app/*' to minimumReleaseAgeExclude when the file sets a
 * top-level minimumReleaseAge. Handles a missing key and a block list ("- item" lines);
 * anything else (an inline [a, b] list) is left for a person, with a warning.
 */
function addReleaseAgeExcludes(text) {
  const lines = text.split("\n");
  if (!lines.some((line) => /^minimumReleaseAge\s*:/.test(line))) return { text, added: [] };

  const keyIndex = lines.findIndex((line) => /^minimumReleaseAgeExclude\s*:/.test(line));
  if (keyIndex === -1) {
    const body = text.endsWith("\n") ? text : `${text}\n`;
    const block = ["minimumReleaseAgeExclude:", ...RELEASE_EXCLUDES.map((item) => `  - ${item}`)].join("\n");
    return { text: `${body}${block}\n`, added: RELEASE_EXCLUDES };
  }
  if (lines[keyIndex].replace(/^minimumReleaseAgeExclude\s*:/, "").trim() !== "") {
    return {
      text,
      added: [],
      warning: `pnpm-workspace.yaml writes minimumReleaseAgeExclude on one line. Make sure it lists ${RELEASE_EXCLUDES.join(" and ")}.`,
    };
  }
  // The block list: the indented "- item" lines right after the key.
  let end = keyIndex + 1;
  const present = [];
  let itemIndent = "  ";
  while (end < lines.length && /^\s+-\s/.test(lines[end])) {
    itemIndent = /^(\s+)-/.exec(lines[end])[1];
    present.push(lines[end].replace(/^\s+-\s+/, "").replace(/['"]/g, "").trim());
    end++;
  }
  const missing = RELEASE_EXCLUDES.filter((item) => !present.includes(item.replace(/'/g, "")));
  if (missing.length === 0) return { text, added: [] };
  lines.splice(end, 0, ...missing.map((item) => `${itemIndent}- ${item}`));
  return { text: lines.join("\n"), added: missing };
}

// 3. The Release workflow.
const workflowPath = path.join(appDir, ".github", "workflows", "release.yml");
const template = fs.readFileSync(TEMPLATE, "utf8");
let writeWorkflow = false;
if (!fs.existsSync(workflowPath)) {
  writeWorkflow = true;
  changes.push(".github/workflows/release.yml: added (the EveryApp starter's Release workflow)");
} else if (fs.readFileSync(workflowPath, "utf8") !== template) {
  warnings.push(
    `.github/workflows/release.yml already exists and differs from templates/release.yml. Left as it is. ` +
      `Check that it runs "pnpm exec everyapp release --publish" with contents: write, or replace it with the template.`,
  );
}
const defaultBranch = gitOutput(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.replace(/^origin\//, "");
if (defaultBranch && defaultBranch !== "main") {
  warnings.push(
    `The default branch is "${defaultBranch}", but the workflow releases on pushes to main. ` +
      `Add ${defaultBranch} under on.push.branches in .github/workflows/release.yml.`,
  );
}

// 4. .gitignore keeps the release tarball out of git.
const gitignorePath = path.join(appDir, ".gitignore");
const gitignoreText = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
const gitignoreHasTarball = gitignoreText.split("\n").some((line) => line.trim() === TARBALL);
if (!gitignoreHasTarball) changes.push(`.gitignore: added ${TARBALL}`);
if (gitOutput(["ls-files", TARBALL])) {
  warnings.push(`${TARBALL} is committed. Remove it: git rm --cached ${TARBALL}`);
}

// 5. Leftovers that must never ship: vendored tarballs.
const vendorDir = path.join(appDir, "vendor");
if (fs.existsSync(vendorDir) && fs.readdirSync(vendorDir).some((name) => /every-?app.*\.tgz$/.test(name))) {
  warnings.push("vendor/ holds EveryApp tarballs. Delete them; the app uses the npm packages now.");
}

// 6. oss.new's own checks: they import oss.new's private test runtime, which only
// exists on oss.new's machines, so they can't run anywhere else.
const checksDir = path.join(appDir, "checks");
const usesOssRuntime =
  fs.existsSync(checksDir) &&
  fs
    .readdirSync(checksDir)
    .filter((name) => /\.m?[jt]s$/.test(name))
    .some((name) => fs.readFileSync(path.join(checksDir, name), "utf8").includes("oss-new/control/runtime"));
if (usesOssRuntime) {
  notes.push(
    "checks/ imports oss.new's private test runtime (/home/user/oss-new/control/runtime), which isn't published. " +
      "Those checks can't run here and aren't a reason to stop. To test, use `pnpm dev` with `pnpm everyapp dev token`.",
  );
}

// 7. Does the lockfile and node_modules need a fresh install?
const lockPath = path.join(appDir, "pnpm-lock.yaml");
const lockText = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : "";
const lockIsPinned = lockSpecifier(lockText, SDK) === version && lockSpecifier(lockText, CLI) === version;
const installedCli = readInstalledVersion(CLI);
const installedSdk = readInstalledVersion(SDK);
const needsInstall =
  packageJsonChanged || workspaceChanged || !lockIsPinned || installedCli !== version || installedSdk !== version;

/** The specifier pnpm-lock.yaml records for a package of the root importer, or null. */
function lockSpecifier(text, name) {
  const lines = text.split("\n");
  const keyPattern = new RegExp(`^\\s+'?${name.replace(/[/.]/g, "\\$&")}'?:\\s*$`);
  for (let i = 0; i < lines.length - 1; i++) {
    if (keyPattern.test(lines[i])) {
      const match = /^\s+specifier:\s*'?([^']+?)'?\s*$/.exec(lines[i + 1]);
      if (match) return match[1];
    }
  }
  return null;
}

function readInstalledVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

function gitOutput(args) {
  try {
    return execFileSync("git", ["-C", appDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

console.log(`${dryRun ? "Dry run: would prepare" : "Preparing"} ${appDir} for EveryApp ${version}`);

if (!dryRun) {
  if (packageJsonChanged) fs.writeFileSync(packageJsonPath, newPackageJsonText);
  if (workspaceChanged) fs.writeFileSync(workspacePath, workspaceText);
  if (writeWorkflow) {
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, template);
  }
  if (!gitignoreHasTarball) {
    const separator = gitignoreText === "" || gitignoreText.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(gitignorePath, `${gitignoreText}${separator}\n# \`everyapp release\`'s tarball\n${TARBALL}\n`);
  }
}

if (needsInstall && !skipInstall && !dryRun) {
  console.log(`\n$ pnpm install   (in ${appDir})`);
  try {
    execFileSync("pnpm", ["install"], { cwd: appDir, stdio: "inherit" });
  } catch (error) {
    if (error.code === "ENOENT") fail("pnpm is not installed. Install it (corepack enable, or npm i -g pnpm), then run this again.");
    fail("pnpm install failed (output above). Fix that, then run this again.");
  }
  const newLock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : "";
  if (lockSpecifier(newLock, SDK) !== version || lockSpecifier(newLock, CLI) !== version) {
    fail(`pnpm-lock.yaml still does not pin both packages to ${version}. Look at it before committing.`);
  }
  if (readInstalledVersion(CLI) !== version || readInstalledVersion(SDK) !== version) {
    fail(`node_modules does not hold everyapp and @every-app/sdk ${version} after the install.`);
  }
  changes.push(`pnpm-lock.yaml and node_modules: ${SDK} and ${CLI} ${version} from npm`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log("");
if (changes.length === 0) {
  console.log("No changes: the app already pins both packages and has the Release workflow.");
} else {
  console.log(dryRun ? "Would change:" : "Changed:");
  for (const change of changes) console.log(`  - ${change}`);
}
if (needsInstall && (dryRun || skipInstall)) {
  console.log(`\nStill to do: pnpm install (the lockfile or node_modules is not on ${version} yet).`);
}
if (warnings.length > 0) {
  console.log("\nLook at:");
  for (const warning of warnings) console.log(`  ! ${warning}`);
}
if (notes.length > 0) {
  console.log("\nGood to know:");
  for (const note of notes) console.log(`  - ${note}`);
}

// Files this kit touches that git sees as changed: those still need a commit.
const KIT_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".gitignore", ".github/workflows/release.yml"];
const changedFiles = gitOutput(["diff", "--name-only", "HEAD", "--", ...KIT_FILES]) ?? "";
const newFiles = gitOutput(["ls-files", "--others", "--exclude-standard", "--", ...KIT_FILES]) ?? "";
const toCommit = dryRun ? [] : `${changedFiles}\n${newFiles}`.split("\n").filter(Boolean);
if (toCommit.length > 0) {
  const remote = gitOutput(["remote", "get-url", "origin"]);
  const repoUrl = toGithubUrl(remote) ?? "https://github.com/<owner>/<repo>";
  console.log("\nNext:");
  console.log(`  cd ${appDir}`);
  console.log(`  git add ${toCommit.join(" ")}`);
  console.log(`  git commit -m "Pin EveryApp ${version} and add the Release workflow"`);
  console.log("  git push");
  console.log("Then wait for the Release workflow to publish a release, and install it:");
  console.log(`  everyapp install ${repoUrl}`);
}

function toGithubUrl(remote) {
  const match = /github\.com[:/]([^/]+)\/(.+?)(\.git)?$/.exec(remote ?? "");
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}
