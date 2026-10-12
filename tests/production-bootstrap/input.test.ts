import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const marker = "disposable-password-marker-not-for-output";
const identity = ["--username", "fixture_admin", "--name", "Fixture Admin"];
function invoke(
  args: string[],
  input?: string,
  extra: Record<string, string> = {},
) {
  return spawnSync(
    process.execPath,
    [
      "./node_modules/tsx/dist/cli.mjs",
      "scripts/installer/production-cli.ts",
      "bootstrap-admin",
      ...args,
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH, NODE_ENV: "production", ...extra },
      input,
      encoding: "utf8",
      timeout: 10000,
    },
  );
}
for (const [name, args, input, extra, code] of [
  [
    "password env",
    identity,
    undefined,
    { BOOTSTRAP_ADMIN_PASSWORD: marker },
    "PASSWORD_ENV_NOT_ALLOWED",
  ],
  [
    "password argv",
    [...identity, "--password", marker],
    undefined,
    {},
    "INVALID_ARGUMENT",
  ],
  [
    "non-TTY implicit stdin",
    identity,
    marker,
    {},
    "TTY_OR_PASSWORD_STDIN_REQUIRED",
  ],
  [
    "multiple password lines",
    [...identity, "--password-stdin"],
    marker + "\nsecond-line\n",
    {},
    "PASSWORD_INPUT_FORMAT",
  ],
  [
    "short password",
    [...identity, "--password-stdin"],
    "short\n",
    {},
    "VALIDATION_OR_RUNTIME_FAILED",
  ],
  [
    "bounded password stream",
    [...identity, "--password-stdin"],
    marker.repeat(30),
    {},
    "VALIDATION_OR_RUNTIME_FAILED",
  ],
  [
    "unexpected identity args",
    [...identity, "--username", "other"],
    undefined,
    {},
    "INVALID_ARGUMENT",
  ],
] as const) {
  test(`${name} is rejected before loading configuration without credential output`, () => {
    const result = invoke([...args], input, extra);
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    assert.ok(output.includes(`FAIL: ${code}`));
    assert.ok(!output.includes(marker));
  });
}
test("one-shot Admin rejects unsafe environment and argument password sources", () => {
  for (const [args, env] of [
    [[], { BOOTSTRAP_ADMIN_PASSWORD: marker }],
    [[marker], {}],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      [
        "./node_modules/tsx/dist/cli.mjs",
        "scripts/bootstrap-admin.ts",
        ...args,
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH, NODE_ENV: "production", ...env },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.status, 1);
    assert.ok(
      (result.stdout + result.stderr).includes("UNSAFE_PASSWORD_SOURCE"),
    );
    assert.ok(!(result.stdout + result.stderr).includes(marker));
  }
});
