import assert from "node:assert/strict";
import test from "node:test";
import { BootstrapFailure, runStages } from "../../scripts/installer/bootstrap";

test("each installation failure stops subsequent mutation and hides external errors", async () => {
  const names = [
    "CONFIG",
    "POSTGRES_READY",
    "MIGRATIONS",
    "GRANTS",
    "WORKER_SECRET",
    "WORKER_LOGIN",
    "APP_HEALTH",
  ];
  for (const failed of names) {
    const visited: string[] = [];
    const output: string[] = [];
    await assert.rejects(
      runStages(
        names.map((name) => ({
          name,
          run() {
            visited.push(name);
            if (name === failed)
              throw new Error("disposable-secret-must-never-be-printed");
          },
        })),
        (line) => output.push(line),
      ),
      (error: unknown) =>
        error instanceof BootstrapFailure &&
        error.code === `${failed}/CHECK_FAILED`,
    );
    assert.deepEqual(visited, names.slice(0, names.indexOf(failed) + 1));
    assert.ok(!output.join("\n").includes("disposable-secret"));
  }
});
