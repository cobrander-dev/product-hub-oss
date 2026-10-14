import { z } from "zod";
import { loadProductionConfig, ConfigFailure } from "./config";
import {
  backup,
  bootstrapAdmin,
  BootstrapFailure,
  doctor,
  install,
  loadInstallation,
} from "./bootstrap";
import { readBoundedInput } from "./input";
import { hiddenInput } from "./tty";

async function main() {
  const command = process.argv[2];
  const args = process.argv
    .slice(3)
    .filter((argument, index) => !(index === 0 && argument === "--"));
  if (
    !["install", "doctor", "bootstrap-admin", "backup"].includes(command || "")
  )
    throw new BootstrapFailure("INVALID_COMMAND");
  if (process.env.BOOTSTRAP_ADMIN_PASSWORD)
    throw new BootstrapFailure("PASSWORD_ENV_NOT_ALLOWED");
  let admin: { username: string; name: string; password: string } | undefined;
  if (command === "bootstrap-admin") {
    const values: Record<string, string> = {};
    let passwordStdin = false;
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]!;
      if (flag === "--password-stdin" && !passwordStdin) {
        passwordStdin = true;
        continue;
      }
      if (
        !["--username", "--name"].includes(flag) ||
        values[flag] ||
        !args[index + 1] ||
        args[index + 1]!.startsWith("--")
      )
        throw new BootstrapFailure("INVALID_ARGUMENT");
      values[flag] = args[++index]!;
    }
    const identity = z
      .object({
        username: z
          .string()
          .trim()
          .min(3)
          .max(30)
          .regex(/^[a-zA-Z0-9._]+$/),
        name: z.string().trim().min(1).max(100),
      })
      .parse({ username: values["--username"], name: values["--name"] });
    let password: string;
    if (passwordStdin) {
      password = (await readBoundedInput(512)).replace(/\r?\n$/, "");
      if (/[\r\n\0]/.test(password))
        throw new BootstrapFailure("PASSWORD_INPUT_FORMAT");
    } else {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new BootstrapFailure("TTY_OR_PASSWORD_STDIN_REQUIRED");
      password = await hiddenInput("Admin password: ");
      if (password !== (await hiddenInput("Confirm password: ")))
        throw new BootstrapFailure("PASSWORD_CONFIRMATION");
    }
    admin = {
      ...identity,
      password: z.string().min(8).max(128).parse(password),
    };
  } else if (args.length) throw new BootstrapFailure("UNEXPECTED_ARGUMENT");
  const config = loadProductionConfig(
    process.env.PRODUCT_HUB_ENV_FILE ||
      "/opt/product-hub/config/product-hub.env",
  );
  const installation = loadInstallation(config);
  if (command === "install") await install(installation);
  else if (command === "doctor") await doctor(installation);
  else if (command === "backup") {
    backup(installation);
    process.stdout.write(
      "PASS: backup complete; verify manifest/checksums in the configured backup root\n",
    );
  } else process.stdout.write(bootstrapAdmin(installation, admin!) + "\n");
}
main().catch((error: unknown) => {
  const code =
    error instanceof ConfigFailure || error instanceof BootstrapFailure
      ? error.code
      : "VALIDATION_OR_RUNTIME_FAILED";
  process.stderr.write(
    `FAIL: ${code}\nNo automatic rollback was performed. Preserve PostgreSQL/volumes; correct this stage or use the reviewed release/recovery workflow.\n`,
  );
  process.exitCode = 1;
});
