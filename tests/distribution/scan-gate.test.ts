import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const source = "1234567890abcdef1234567890abcdef12345678";
const script = resolve("scripts/release/staged-images.ts");
const tsx = resolve("node_modules/tsx/dist/cli.mjs");
const hash = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "product-hub-scan-gate-"));
  const bin = join(root, "bin");
  const artifacts = join(root, "artifacts");
  const blobs = join(root, "blobs/sha256");
  mkdirSync(bin);
  mkdirSync(artifacts);
  mkdirSync(blobs, { recursive: true });
  const attestation = JSON.stringify({
    layers: [
      "https://spdx.dev/Document",
      "https://slsa.dev/provenance/v0.2",
    ].map((type) => ({ annotations: { "in-toto.io/predicate-type": type } })),
  });
  const attestationDigest = hash(attestation);
  writeFileSync(join(blobs, attestationDigest.slice(7)), attestation);
  const runtimeDigest = `sha256:${"1".repeat(64)}`;
  const index = JSON.stringify({
    manifests: [
      {
        digest: runtimeDigest,
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        digest: attestationDigest,
        annotations: {
          "vnd.docker.reference.type": "attestation-manifest",
          "vnd.docker.reference.digest": runtimeDigest,
        },
      },
    ],
  });
  const config = {
    os: "linux",
    architecture: "amd64",
    config: {
      Labels: {
        "org.opencontainers.image.revision": source,
        "org.opencontainers.image.version": `verification-${source}`,
      },
    },
  };
  writeFileSync(
    join(root, "facts.json"),
    JSON.stringify({
      index,
      attestation,
      attestationDigest,
      config,
      digest: hash(index),
    }),
  );
  for (const name of ["runner", "migrator", "worker"])
    assert.equal(
      spawnSync("tar", [
        "-cf",
        join(artifacts, `${name}.tar`),
        "-C",
        root,
        "blobs",
      ]).status,
      0,
    );
  const common = `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);const log=s=>fs.appendFileSync(process.env.GATE_LOG,s+'\\n');\n`;
  writeFileSync(
    join(bin, "docker"),
    common +
      `log('SCAN '+a.join(' '));const gate=a.includes('--ignore-unfixed');const name=a[a.indexOf('--input')+1].slice(6,-7);const env=process.env;` +
      `if(env.TRIVY_ERROR){process.stderr.write('x\\n'.repeat(60)+'FATAL db https://bot:hunter2@ghcr.io token=abc123 tail\\n');process.exit(1);}` +
      `const fixable={VulnerabilityID:'CVE-FIXABLE',PkgName:'lib',InstalledVersion:'1',FixedVersion:'2',Status:'fixed',Severity:'HIGH'};` +
      `const unfixed={VulnerabilityID:'CVE-UNFIXED',PkgName:'os',InstalledVersion:'1',Status:'affected',Severity:'CRITICAL'};` +
      `const low={VulnerabilityID:'CVE-LOW',PkgName:'os',InstalledVersion:'1',FixedVersion:'2',Severity:'LOW'};` +
      `const secret={RuleID:'aws-access-key-id',Severity:'CRITICAL',Title:'AWS',StartLine:1,EndLine:1,Match:'AKIASECRETVALUE',Code:{Lines:[{Content:'AKIASECRETVALUE'}]}};` +
      `const failing=env.FAIL_SCAN===name,secrets=env.SECRET_SCAN===name?[secret]:[];` +
      `const many=env.MANY?Array.from({length:120},(_,i)=>({...unfixed,VulnerabilityID:'CVE-MANY-'+i})):[];const v=gate?(failing?[fixable]:[]):[unfixed,low,...many,...(failing||env.INCONSISTENT===name?[fixable]:[])];` +
      `process.stdout.write(JSON.stringify({Results:[{Target:name,Vulnerabilities:v,Secrets:secrets}]}));process.exit(gate&&(failing||secrets.length)?1:0);`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "skopeo"),
    common +
      `const f=JSON.parse(fs.readFileSync(process.env.GATE_FACTS));if(a.includes('copy')){if(a.at(-1).startsWith('oci:')){log('LAYOUT '+a.join(' '));}else{log('PUSH '+a.at(-1));fs.writeFileSync(a[a.indexOf('--digestfile')+1],f.digest);}}else if(a.includes('--config'))process.stdout.write(JSON.stringify(f.config));else if(process.env.BAD_LAYOUT && a.at(-1).startsWith('oci:'))process.stdout.write(f.index+' ');else process.stdout.write(a.at(-1).endsWith('@'+f.attestationDigest)?f.attestation:f.index);`,
    { mode: 0o755 },
  );
  const log = join(root, "events.log");
  writeFileSync(log, "");
  const run = (command: string, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [tsx, script, command, artifacts, source], {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH}`,
        GATE_LOG: log,
        GATE_FACTS: join(root, "facts.json"),
        ...extra,
      },
    });
  return { root, artifacts, log, run };
}

for (const failedImage of ["runner", "migrator", "worker"])
  test(`Critical/High scanner failure for ${failedImage} prevents ALL pushes`, () => {
    const f = fixture();
    try {
      assert.equal(f.run("scan", { FAIL_SCAN: failedImage }).status, 1);
      assert.equal(existsSync(join(f.artifacts, "scan-pass.json")), false);
      assert.equal(f.run("publish").status, 1);
      assert.doesNotMatch(readFileSync(f.log, "utf8"), /PUSH/);
    } finally {
      rmSync(f.root, { recursive: true });
    }
  });
test("three scan gates precede digest-preserving pushes without rebuilding", () => {
  const f = fixture();
  try {
    assert.equal(f.run("scan").status, 0);
    assert.equal(f.run("publish").status, 0);
    const allEvents = readFileSync(f.log, "utf8").trim().split("\n");
    assert.equal(
      allEvents.filter(
        (line) =>
          line.startsWith("LAYOUT ") &&
          line.includes("--all --preserve-digests"),
      ).length,
      3,
    );
    const events = allEvents.filter((line) => !line.startsWith("LAYOUT "));
    const scans = events.filter((line) => line.startsWith("SCAN "));
    assert.equal(scans.length, 6);
    assert.equal(events.filter((line) => line.startsWith("PUSH ")).length, 3);
    assert.ok(events.slice(0, 6).every((line) => line.startsWith("SCAN ")));
    assert.ok(events.slice(6).every((line) => line.endsWith(`:sha-${source}`)));
    assert.doesNotMatch(events.join("\n"), /buildx|:latest/);
    // Each image: unfiltered full inventory first, then the official gate.
    for (const [index, line] of scans.entries()) {
      assert.match(line, /--scanners vuln,secret --format json/);
      if (index % 2 === 0) {
        assert.doesNotMatch(line, /--ignore-unfixed|--severity|--exit-code 1/);
        assert.match(line, /--exit-code 0/);
      } else
        assert.match(
          line,
          /--severity CRITICAL,HIGH --ignore-unfixed --skip-db-update --exit-code 1$/,
        );
    }
    for (const name of ["runner", "migrator", "worker"]) {
      const report = readFileSync(
        join(f.artifacts, "scan-reports", `${name}.full.json`),
        "utf8",
      );
      assert.match(report, /CVE-UNFIXED/);
      assert.match(report, /CVE-LOW/);
    }
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
test("scan output lists unfixed Critical/High and the blocking fixable finding", () => {
  const f = fixture();
  try {
    const result = f.run("scan", { FAIL_SCAN: "migrator" });
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /\[runner\] full inventory: CRITICAL=1 HIGH=0 MEDIUM=0 LOW=1 UNKNOWN=0; Critical\/High fixable=0 unfixed=1; Critical\/High secret findings 0\n/,
    );
    assert.match(
      result.stdout,
      /CRITICAL CVE-UNFIXED os 1 -> no fix \(affected\)/,
    );
    assert.match(
      result.stdout,
      /\[migrator\] BLOCKING fixable Critical\/High or secret[\s\S]*HIGH CVE-FIXABLE lib 1 -> 2/,
    );
    assert.match(result.stderr, /FAIL: FIXABLE_CRITICAL_HIGH_OR_SECRET/);
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
test("complete Critical/High inventory is printed without truncation", () => {
  const f = fixture();
  try {
    const result = f.run("scan", { MANY: "1" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[runner\] full inventory: CRITICAL=121/);
    for (const id of ["CVE-MANY-0", "CVE-MANY-119"])
      assert.equal(result.stdout.split(` ${id} `).length - 1, 3);
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
test("Trivy runtime failures show bounded redacted diagnostics, never DOCKER_FAILED alone", () => {
  const f = fixture();
  try {
    const result = f.run("scan", { TRIVY_ERROR: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /trivy diagnostics:[\s\S]*tail/);
    assert.match(result.stderr, /\[REDACTED\]/);
    assert.doesNotMatch(result.stderr, /hunter2|abc123|DOCKER_FAILED/);
    assert.ok(result.stderr.split("\n").length < 50);
    assert.match(result.stderr, /FAIL: TRIVY_FULL_SCAN_FAILED/);
    assert.equal(f.run("publish").status, 1);
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
test("full inventory and gate disagreement fails closed", () => {
  const f = fixture();
  try {
    const result = f.run("scan", { INCONSISTENT: "worker" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL: SCAN_GATE_INCONSISTENT/);
    assert.equal(existsSync(join(f.artifacts, "scan-pass.json")), false);
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
test("secret findings block publish without retaining or printing secret content", () => {
  const f = fixture();
  try {
    const result = f.run("scan", { SECRET_SCAN: "runner" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /SECRET aws-access-key-id \[runner\]/);
    assert.match(result.stderr, /FAIL: FIXABLE_CRITICAL_HIGH_OR_SECRET/);
    const report = readFileSync(
      join(f.artifacts, "scan-reports", "runner.full.json"),
      "utf8",
    );
    assert.match(report, /aws-access-key-id/);
    assert.doesNotMatch(
      report + result.stdout + result.stderr,
      /AKIASECRETVALUE/,
    );
    assert.equal(f.run("publish").status, 1);
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
test("OCI layout digest mismatch blocks scanning and every push", () => {
  const f = fixture();
  try {
    const result = f.run("scan", { BAD_LAYOUT: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SCAN_LAYOUT_DIGEST_CHANGED/);
    assert.equal(f.run("publish").status, 1);
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /SCAN |PUSH /);
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
test("changing ANY archive after scan prevents even the first push", () => {
  const f = fixture();
  try {
    assert.equal(f.run("scan").status, 0);
    appendFileSync(join(f.artifacts, "worker.tar"), "tamper");
    assert.equal(f.run("publish").status, 1);
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /PUSH/);
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
