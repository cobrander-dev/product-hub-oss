import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";

const child = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "-p", "3100"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
for (const stream of [child.stdout, child.stderr]) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString();
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index).replace(/\u001b\[[0-9;]*m/g, "");
      pending = pending.slice(index + 1);
      // Only HTTP timing/status, never arbitrary server messages/arguments.
      const match =
        /^\s*(GET|POST|PUT|DELETE|PATCH) (\/[A-Za-z0-9_./-]+)(?:\?\S*)? (\d{3}) in ([\d.]+(?:ms|s))/.exec(
          line,
        );
      if (match) {
        mkdirSync("test-results", { recursive: true });
        appendFileSync(
          "test-results/safe-server.jsonl",
          JSON.stringify({
            at: new Date().toISOString(),
            method: match[1],
            path: match[2].replace(/[A-Za-z0-9_-]{32,}/g, "[OPAQUE_VALUE]"),
            status: Number(match[3]),
            duration: match[4],
          }) + "\n",
          { mode: 0o600 },
        );
      }
    }
    if (pending.length > 1_000_000) pending = "";
  });
}
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("error", () => {
  process.stderr.write("Diagnostic test server failed to start\n");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
