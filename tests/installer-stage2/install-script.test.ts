import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("install.sh", "utf8");
const code = script
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

test("install.sh is valid POSIX sh without tracing or eval", () => {
  assert.equal(spawnSync("sh", ["-n", "install.sh"]).status, 0);
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.match(script, /\nset -eu\n/);
  assert.doesNotMatch(code, /set -x|\beval\b|curl[^\n]*\|\s*(ba)?sh/);
});

test("Docker is installed only after consent from the pinned official repository", () => {
  assert.match(
    script,
    /docker_gpg_fingerprint=9DC858229FC7DD38854AE2D88D81803C0EBFCD88/,
  );
  assert.match(script, /DOCKER_KEY_MISMATCH/);
  assert.match(script, /https:\/\/download\.docker\.com\/linux\//);
  const consent = script.indexOf("是否从 Docker 官方源自动安装");
  assert.ok(consent > 0 && script.indexOf("install_docker ;;") > consent);
  assert.doesNotMatch(script, /get\.docker\.com/);
});

test("release bundle is checksum-verified before extraction and setup", () => {
  const verify = script.indexOf("sha256sum --check --strict --quiet)");
  const extract = script.indexOf("tar -xzf");
  const manifest = script.indexOf("product-hub-release.manifest.sha256)");
  const setup = script.indexOf('sh "$work/bundle/setup.sh"');
  assert.ok(
    verify > 0 && extract > verify && manifest > extract && setup > manifest,
  );
  assert.match(script, /--proto '=https' --tlsv1\.2/);
  assert.match(script, /gh attestation verify/);
  assert.match(script, /--no-same-owner/);
});

test("existing installs open the menu instead of being overwritten", () => {
  const existing = script.indexOf('if [ -e "$install_root" ]');
  const download = script.indexOf("下载安装包");
  assert.ok(existing > 0 && download > existing);
  assert.match(script, /exec "\$cli_path" <\/dev\/tty/);
});

test("install.sh and product-hub accept SemVer pre-releases but reject other versions", () => {
  const cli = readFileSync("scripts/product-hub", "utf8");
  for (const source of [script, cli]) {
    const pattern = /grep -Eq '(\^v[^']+)' \|\| fail INVALID_VERSION/.exec(
      source,
    )?.[1];
    assert.ok(pattern);
    const accepts = (value: string) =>
      spawnSync("grep", ["-Eq", pattern], { input: value }).status === 0;
    for (const value of ["v0.9.0", "v0.9.0-rc.1", "v1.0.0", "v10.2.3-beta.2"])
      assert.ok(accepts(value), value);
    for (const value of [
      "0.9.0",
      "v0.9",
      "v01.0.0",
      "v1.0.0+build",
      "latest",
      "v1.0.0-",
      "v1.0.0-rc.1;id",
    ])
      assert.ok(!accepts(value), value);
  }
});
