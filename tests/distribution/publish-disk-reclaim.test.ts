import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const sdk = "/usr/local/lib/android/sdk";
const script = pathToFileURL(
  resolve(".github/scripts/reclaim-publish-disk.mjs"),
);
// All OS/filesystem/process calls are stubbed. These tests NEVER invoke sudo/rm.
function simulate(options: Record<string, unknown> = {}) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      String.raw`
    import { reclaimPublishDisk } from ${JSON.stringify(script.href)};
    const options = ${JSON.stringify(options)};
    const calls = [], logs = [];
    let measurements = 0;
    let error = null;
    try {
      reclaimPublishDisk({
        env: {
          GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
          GITHUB_JOB: 'publish', RELEASE_MODE: 'verification',
          RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: 'ubuntu24',
          GITHUB_WORKSPACE: '/work', RUNNER_TEMP: '/temp', RUNNER_TOOL_CACHE: '/toolcache',
          ...options.env,
        },
        platform: options.platform || 'linux', arch: options.arch || 'x64',
        nodePath: '/toolcache/node/bin/node',
        read: () => options.os || 'ID=ubuntu\nVERSION_ID="24.04"',
        realpath: (path) => path === ${JSON.stringify(sdk)} ? (options.realpath || path) : path,
        stat: () => {
          if (options.absent) throw Object.assign(new Error(), { code: 'ENOENT' });
          return { isDirectory: () => !options.notDirectory, isSymbolicLink: () => !!options.symlink, uid: options.uid ?? 0 };
        },
        run: (command, args) => {
          calls.push([command, ...args]);
          if (command === 'docker') return options.dockerRoot || '/var/lib/docker';
          if (command === 'df') return 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/root 75000000 0 ' +
            (options.invalidDf ? 'invalid' : ++measurements === 1 ? '12363124' : '20000000') + ' 0% /';
          if (command === 'findmnt') return JSON.stringify({filesystems: options.mounts || [{target:'/'}]});
          if (command === 'du') return '7636876\t${sdk}';
          if (command === 'sudo') { if (options.removeFailure) throw new Error('denied'); return ''; }
          throw new Error('unexpected command');
        },
        log: (message) => logs.push(message),
      });
    } catch (e) { error = e.message; }
    console.log(JSON.stringify({calls, logs, error}));
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    calls: string[][];
    logs: string[];
    error: string | null;
  };
}

test("only hosted verification Source/Publish Ubuntu x64 can request SDK reclaim", () => {
  for (const env of [
    { GITHUB_ACTIONS: "false" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { GITHUB_JOB: "build" },
    { GITHUB_JOB: "" },
    { GITHUB_JOB: "source-verification-extra" },
    { RELEASE_MODE: "release" },
    { RUNNER_OS: "macOS" },
    { RUNNER_ARCH: "ARM64" },
    { ImageOS: "ubuntu22" },
  ]) {
    const result = simulate({ env });
    assert.equal(result.error, "HOSTED_PUBLISH_RUNNER_REQUIRED");
    assert.deepEqual(result.calls, []);
  }
  for (const options of [
    { platform: "darwin" },
    { arch: "arm64" },
    { os: "ID=debian" },
  ]) {
    const result = simulate(options);
    assert.ok(result.error);
    assert.deepEqual(result.calls, []);
  }
});

test("Source Verification runner reclaims the same single SDK path", () => {
  const result = simulate({ env: { GITHUB_JOB: "source-verification" } });
  assert.equal(result.error, null);
  assert.deepEqual(
    result.calls.filter(([command]) => command === "sudo").map((c) => c.at(-1)),
    [sdk],
  );
});

test("reclaim deletes exactly the SDK allowlist and records actual before/after", () => {
  const result = simulate();
  assert.equal(result.error, null);
  assert.deepEqual(
    result.calls.filter(([command]) => command === "sudo"),
    [
      [
        "sudo",
        "-n",
        "/bin/rm",
        "--one-file-system",
        "--preserve-root=all",
        "--recursive",
        "--force",
        "--",
        sdk,
      ],
    ],
  );
  assert.match(result.logs.join("\n"), /before SDK reclaim: 12363124 KiB/);
  assert.match(result.logs.join("\n"), /allocated size: 7636876 KiB/);
  assert.match(
    result.logs.join("\n"),
    /after SDK reclaim: 20000000 KiB available; delta 7636876 KiB/,
  );
});

test("unsafe SDK layouts and protected paths fail before any deletion", () => {
  for (const options of [
    { symlink: true },
    { notDirectory: true },
    { uid: 1001 },
    { realpath: "/other/sdk" },
    { mounts: [{ target: sdk }] },
    { mounts: [{ target: `${sdk}/mounted` }] },
    { mounts: [] },
    { mounts: [{}] },
    { invalidDf: true },
    { env: { GITHUB_WORKSPACE: `${sdk}/source` } },
    { env: { RUNNER_TEMP: "/usr/local/lib/android" } },
    { env: { RUNNER_TOOL_CACHE: sdk } },
    { env: { GITHUB_WORKSPACE: "" } },
    { dockerRoot: `${sdk}/docker` },
  ]) {
    const result = simulate(options);
    assert.ok(result.error, JSON.stringify(options));
    assert.ok(!result.calls.some(([command]) => command === "sudo"));
  }
});

test("missing SDK is a no-op and deletion failure cannot be reported as success", () => {
  const missing = simulate({ absent: true });
  assert.equal(missing.error, null);
  assert.ok(!missing.calls.some(([command]) => command === "sudo"));
  assert.match(missing.logs.join("\n"), /Original disk gate still required/);
  const failure = simulate({ removeFailure: true });
  assert.ok(failure.error);
  assert.doesNotMatch(failure.logs.join("\n"), /after SDK reclaim/);
});

test("workflow retains the original disk floor and all security gates after reclaim", () => {
  const workflow = readFileSync(".github/workflows/release-images.yml", "utf8");
  const publish = workflow.slice(
    workflow.indexOf("  publish:"),
    workflow.indexOf("  github-release:"),
  );
  const source = workflow.slice(0, workflow.indexOf("  publish:"));
  assert.equal(source.split("reclaim-publish-disk.mjs").length - 1, 1);
  assert.match(
    source,
    /name: Reclaim unused preinstalled Android SDK on hosted Source Verification runner\n\s+if: inputs.mode == 'verification'/,
  );
  assert.ok(
    source.indexOf("reclaim-publish-disk.mjs") >
      source.indexOf("workflow-identity.ts"),
  );
  assert.ok(
    source.indexOf("reclaim-publish-disk.mjs") <
      source.indexOf("release-disk-check.sh source-baseline 0"),
  );
  assert.match(source, /release-disk-check.sh before-fixtures 8192/);
  assert.doesNotMatch(
    source,
    /continue-on-error|docker .*prune|apt.*autoremove/,
  );
  assert.match(
    publish,
    /name: Reclaim unused preinstalled Android SDK on hosted Publish runner\n\s+if: inputs.mode == 'verification'/,
  );
  assert.ok(
    publish.indexOf("reclaim-publish-disk.mjs") >
      publish.indexOf("workflow-identity.ts"),
  );
  assert.ok(
    publish.indexOf("reclaim-publish-disk.mjs") <
      publish.indexOf("release-disk-check.sh oci-baseline 12288"),
  );
  assert.ok(
    publish.indexOf("release-disk-check.sh oci-baseline 12288") <
      publish.indexOf("Set up Docker Buildx"),
  );
  assert.match(publish, /release-disk-check.sh before-runner 12288/);
  assert.doesNotMatch(
    publish,
    /continue-on-error|docker .*prune|apt.*autoremove/,
  );
  const cleanup = readFileSync(
    ".github/scripts/reclaim-publish-disk.mjs",
    "utf8",
  );
  assert.doesNotMatch(cleanup, /process\.argv\[2\]|execSync\(|shell:\s*true/);
});
