import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function connectionEnvironment(value) {
  const url = new URL(value);
  if (
    !["postgresql:", "postgres:"].includes(url.protocol) ||
    url.hash ||
    !url.hostname
  )
    throw new Error("BACKUP_CONNECTION_FORMAT");
  const fields = {
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
  };
  const password = decodeURIComponent(url.password);
  if (
    Object.values(fields).some((item) => !item || /[\r\n\0]/.test(item)) ||
    !password ||
    /[\r\n\0]/.test(password)
  )
    throw new Error("BACKUP_CONNECTION_FORMAT");
  const allowed = {
    sslmode: "PGSSLMODE",
    sslrootcert: "PGSSLROOTCERT",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
    connect_timeout: "PGCONNECT_TIMEOUT",
    application_name: "PGAPPNAME",
    options: "PGOPTIONS",
  };
  const options = {};
  for (const [key, item] of url.searchParams) {
    if (
      !Object.hasOwn(allowed, key) ||
      Object.hasOwn(options, key) ||
      /[\r\n\0]/.test(item)
    )
      throw new Error("BACKUP_CONNECTION_OPTION");
    options[key] = item;
    fields[allowed[key]] = item;
  }
  const escape = (item) => item.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
  return {
    fields,
    passfile:
      [fields.PGHOST, fields.PGPORT, fields.PGDATABASE, fields.PGUSER, password]
        .map(escape)
        .join(":") + "\n",
  };
}

function main() {
  let directory;
  try {
    if (process.argv.length !== 3) throw new Error();
    const { fields, passfile } = connectionEnvironment(
      process.env.DATABASE_URL,
    );
    directory = mkdtempSync(join(tmpdir(), "product-hub-backup-connection-"));
    const file = join(directory, "pgpass");
    writeFileSync(file, passfile, { mode: 0o600, flag: "wx" });
    const env = { ...process.env, ...fields, PGPASSFILE: file };
    for (const key of [
      "DATABASE_URL",
      "PGPASSWORD",
      "PGSERVICE",
      "PGSERVICEFILE",
    ])
      delete env[key];
    const result = spawnSync("sh", [process.argv[2]], {
      env,
      stdio: "inherit",
    });
    process.exitCode = result.status ?? 1;
  } catch {
    process.stderr.write("FAIL: BACKUP_CONNECTION\n");
    process.exitCode = 1;
  } finally {
    if (directory) rmSync(directory, { recursive: true });
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main();
