import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectSafeArtifacts,
  diagnosticZip,
  safeTraceRecord,
  traceEntries,
} from "../support/safe-artifacts";
import { diagnosticRedactor } from "../support/diagnostic-redaction";

test("exported trace retains actions, DOM and statuses but not credentials or bodies", () => {
  const password = "secret-fixture-password";
  const token = "unlisted-session-token-that-is-long-enough-to-match";
  const redact = diagnosticRedactor([password]);
  const records = [
    {
      type: "before",
      callId: "call@1",
      method: "fill",
      params: { value: password, selector: "input[name=password]" },
      title: `Fill ${password}`,
    },
    { type: "after", callId: "call@1", error: { message: token } },
    {
      type: "frame-snapshot",
      snapshot: {
        html: [
          "HTML",
          {},
          [
            "BODY",
            {},
            ["INPUT", { value: password }],
            ["SCRIPT", {}, token],
            ["TEXTAREA", {}, password],
            ["H2", {}, "厂家私图"],
            ["P", {}, password],
          ],
        ],
      },
    },
    {
      type: "resource-snapshot",
      snapshot: {
        request: {
          method: "POST",
          url: `http://localhost/api/auth?token=${token}`,
          headers: [{ name: "cookie", value: token }],
          postData: { text: password },
        },
        response: {
          status: 200,
          headers: [{ name: "set-cookie", value: token }],
          content: { text: password },
        },
      },
    },
    { type: "console", text: password, args: [token], messageType: "error" },
    { type: "log", message: `password ${password}` },
    { type: "screencast-frame", file: "unsafe.jpeg" },
  ].map((record) => safeTraceRecord(record, redact));
  const text = JSON.stringify(records);
  for (const value of [
    password,
    token,
    "unsafe.jpeg",
    "set-cookie",
    "postData",
  ])
    assert.ok(!text.includes(value));
  assert.match(text, /厂家私图/);
  assert.match(text, /"status":200/);
  assert.match(text, /"method":"fill"/);
});

test("safe archive collector rebuilds a readable ZIP and excludes raw resources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "product-hub-safe-trace-"));
  try {
    const secret = "random-fixture-password";
    for (const file of [".env", ".env.test", ".env.ci-db"])
      await writeFile(
        path.join(root, file),
        `TEST_ADMIN_PASSWORD=${secret}\nDATABASE_URL=postgresql://user:${secret}@localhost/unit_test\n`,
      );
    await mkdir(path.join(root, "test-results/case"), { recursive: true });
    const archive = diagnosticZip(
      new Map([
        [
          "0-trace.trace",
          Buffer.from(
            JSON.stringify({
              type: "before",
              callId: "call@1",
              method: "fill",
              params: { value: secret },
            }) + "\n",
          ),
        ],
        ["resources/body.txt", Buffer.from(secret)],
        ["resources/screenshot.jpeg", Buffer.from(secret)],
      ]),
    );
    await writeFile(path.join(root, "test-results/case/trace.zip"), archive);
    await writeFile(
      path.join(root, "test-results/case/error-context.md"),
      secret,
    );
    const output = path.join(root, "safe");
    assert.equal(await collectSafeArtifacts(root, output), 1);
    const safe = await traceEntries(path.join(output, "case/trace.zip"));
    assert.equal(safe.size, 1);
    assert.ok(![...safe.values()].some((entry) => entry.includes(secret)));
    assert.equal(
      JSON.parse(safe.get("0-trace.trace")!.toString()).method,
      "fill",
    );
    await symlink(
      path.join(root, ".env"),
      path.join(root, "test-results/safe-network.json"),
    );
    await assert.rejects(
      collectSafeArtifacts(root, path.join(root, "rejected")),
      /SYMLINK/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing credentials, missing trace and corrupt archive fail closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "product-hub-invalid-trace-"));
  try {
    await assert.rejects(collectSafeArtifacts(root, path.join(root, "out")));
    for (const file of [".env", ".env.test", ".env.ci-db"])
      await writeFile(
        path.join(root, file),
        "TEST_ADMIN_PASSWORD=fixture-password\n",
      );
    await mkdir(path.join(root, "test-results"));
    await assert.rejects(
      collectSafeArtifacts(root, path.join(root, "out")),
      /TRACE_MISSING/,
    );
    await writeFile(path.join(root, "test-results/trace.zip"), "invalid zip");
    await assert.rejects(
      collectSafeArtifacts(root, path.join(root, "out")),
      /ARCHIVE_INVALID/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow uploads only successfully sanitized failure evidence before always cleanup", async () => {
  const workflow = await readFile(
    ".github/workflows/release-images.yml",
    "utf8",
  );
  const sanitize = workflow.indexOf("- name: Sanitize failed browser evidence");
  const upload = workflow.indexOf(
    "- name: Upload sanitized failure evidence only",
  );
  const cleanup = workflow.indexOf("- name: Remove isolated test credentials");
  assert.ok(
    sanitize > workflow.indexOf("pnpm ci:check") &&
      sanitize < upload &&
      upload < cleanup,
  );
  assert.match(
    workflow.slice(sanitize, upload),
    /if: failure\(\) && inputs.mode == 'verification'/,
  );
  assert.match(
    workflow.slice(upload, cleanup),
    /if: failure\(\) && steps.failure_diagnostics.outcome == 'success'/,
  );
  assert.match(workflow.slice(upload, cleanup), /retention-days: 7/);
  assert.doesNotMatch(workflow.slice(upload, cleanup), /source\/test-results/);
});
