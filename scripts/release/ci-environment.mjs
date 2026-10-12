import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// GitHub-hosted release verification only. Never read a deployment credential.
function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error("CI_DATABASE_COMMAND_FAILED");
  return result.stdout.trim();
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw new Error("GITHUB_ACTIONS_REQUIRED");
  const run = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  if (!/^\d+-\d+$/.test(run)) throw new Error("CI_RUN_ID_REQUIRED");
  const name = `product-hub-release-ci-${run}`;
  const marker = resolve(".env.ci-owner");
  const files = [".env", ".env.test", ".env.ci-db"];
  if (process.argv[2] === "cleanup") {
    if (!existsSync(marker)) return;
    if (readFileSync(marker, "utf8") !== run)
      throw new Error("CI_OWNER_MISMATCH");
    const id = docker([
      "ps",
      "-aq",
      "--filter",
      `name=^/${name}$`,
      "--filter",
      `label=product-hub.release-ci=${run}`,
    ]);
    if (id) docker(["rm", "-f", "-v", id]);
    for (const file of files) if (existsSync(file)) unlinkSync(file);
    unlinkSync(marker);
    return;
  }
  if (process.argv[2] !== "prepare") throw new Error("INVALID_COMMAND");
  if ([...files, marker].some(existsSync))
    throw new Error("CI_ENV_ALREADY_EXISTS");
  writeFileSync(marker, run, { mode: 0o600, flag: "wx" });
  const secret = () => randomBytes(32).toString("hex");
  const password = secret();
  const common = {
    DATABASE_URL: `postgresql://release_ci:${password}@127.0.0.1:54329/product_hub_release_test`,
    BETTER_AUTH_SECRET: secret(),
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_ROOT: resolve("data/test-uploads"),
    TEST_ADMIN_PASSWORD: secret(),
    TEST_FACTORY_A_PASSWORD: secret(),
    TEST_FACTORY_B_PASSWORD: secret(),
    TEST_NEW_PASSWORD: secret(),
  };
  const write = (file, values) =>
    writeFileSync(
      file,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
      { mode: 0o600, flag: "wx" },
    );
  for (const [file, origin] of [
    [".env", "http://localhost:3000"],
    [".env.test", "http://127.0.0.1:3100"],
  ])
    write(file, {
      ...common,
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_TRUSTED_ORIGINS: origin,
    });
  write(".env.ci-db", {
    POSTGRES_USER: "release_ci",
    POSTGRES_PASSWORD: password,
    POSTGRES_DB: "product_hub_release_test",
  });
  const image = readFileSync(
    "deploy/releases/postgres-linux-amd64.txt",
    "utf8",
  ).trim();
  if (!/^postgres@sha256:[0-9a-f]{64}$/.test(image))
    throw new Error("CI_POSTGRES_DIGEST");
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `product-hub.release-ci=${run}`,
    "--platform",
    "linux/amd64",
    "--env-file",
    ".env.ci-db",
    "-p",
    "127.0.0.1:54329:5432",
    image,
  ]);
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = spawnSync(
      "docker",
      [
        "exec",
        name,
        "pg_isready",
        "-U",
        "release_ci",
        "-d",
        "product_hub_release_test",
      ],
      { stdio: "ignore" },
    );
    if (result.status === 0) return;
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error("CI_DATABASE_NOT_READY");
}

main().catch(() => {
  process.stderr.write(
    "FAIL: isolated release CI environment; details suppressed\n",
  );
  process.exitCode = 1;
});
