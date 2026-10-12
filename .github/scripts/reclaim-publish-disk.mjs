import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// One reviewed preinstalled SDK only. No CLI/env override for the deletion path.
const sdk = "/usr/local/lib/android/sdk";
const overlaps = (a, b) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const fail = (code) => {
  throw new Error(code);
};

// Injectable system calls allow non-destructive tests, never a production CLI bypass.
export function reclaimPublishDisk({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  nodePath = process.execPath,
  read = readFileSync,
  realpath = realpathSync,
  stat = lstatSync,
  run = (command, args) =>
    execFileSync(command, args, { encoding: "utf8" }).trim(),
  log = console.log,
} = {}) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    // Both verification runners only; never another job or release promotion.
    !["source-verification", "publish"].includes(env.GITHUB_JOB) ||
    env.RELEASE_MODE !== "verification" ||
    env.RUNNER_OS !== "Linux" ||
    env.RUNNER_ARCH !== "X64" ||
    env.ImageOS !== "ubuntu24" ||
    platform !== "linux" ||
    arch !== "x64"
  )
    fail("HOSTED_PUBLISH_RUNNER_REQUIRED");
  const os = read("/etc/os-release", "utf8");
  if (!/^ID=ubuntu$/m.test(os) || !/^VERSION_ID="24\.04"$/m.test(os))
    fail("UBUNTU_24_REQUIRED");

  const dockerRoot = run("docker", ["info", "--format", "{{.DockerRootDir}}"]);
  const protectedPaths = [
    env.GITHUB_WORKSPACE,
    env.RUNNER_TEMP,
    env.RUNNER_TOOL_CACHE,
    nodePath,
    dockerRoot,
  ].map((path) => {
    if (!path || !path.startsWith("/")) fail("PROTECTED_PATH_REQUIRED");
    return realpath(path);
  });
  if (protectedPaths.some((path) => overlaps(sdk, path)))
    fail("PROTECTED_PATH_OVERLAP");
  const free = () => {
    const output = run("df", ["-Pk", env.GITHUB_WORKSPACE]);
    const value = output.trim().split("\n")[1]?.trim().split(/\s+/)[3];
    if (!/^\d+$/.test(value || "")) fail("INVALID_DISK_MEASUREMENT");
    return Number(value);
  };
  const before = free();
  log(`Publish disk before SDK reclaim: ${before} KiB available`);
  let info;
  try {
    info = stat(sdk);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    log("Android SDK absent; no deletion. Original disk gate still required.");
    return;
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== 0 ||
    realpath(sdk) !== sdk
  )
    fail("UNSAFE_SDK_PATH");
  const mounts = JSON.parse(
    run("findmnt", ["--json", "--list", "--output", "TARGET"]),
  );
  if (!Array.isArray(mounts.filesystems) || !mounts.filesystems.length)
    fail("MOUNT_INVENTORY_REQUIRED");
  for (const mount of mounts.filesystems) {
    if (typeof mount.target !== "string" || !mount.target.startsWith("/"))
      fail("INVALID_MOUNT");
    if (mount.target === sdk || mount.target.startsWith(`${sdk}/`))
      fail("SDK_MOUNT_FORBIDDEN");
  }
  const size = run("du", ["-sk", "--", sdk]).split(/\s+/)[0];
  if (!/^\d+$/.test(size)) fail("INVALID_SDK_MEASUREMENT");
  log(`Allowlisted Android SDK allocated size: ${size} KiB`);
  run("sudo", [
    "-n",
    "/bin/rm",
    "--one-file-system",
    "--preserve-root=all",
    "--recursive",
    "--force",
    "--",
    sdk,
  ]);
  const after = free();
  log(
    `Publish disk after SDK reclaim: ${after} KiB available; delta ${after - before} KiB`,
  );
  log("Original 12288 MiB disk gate must pass before OCI/SBOM build.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    reclaimPublishDisk();
  } catch {
    // Suppress system command output/paths; never emit credential-bearing errors.
    console.error(
      "::error::Publish SDK reclaim failed closed; no build or publish allowed",
    );
    process.exitCode = 1;
  }
}
