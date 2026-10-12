import { readFile, writeFile, mkdir, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";
import {
  diagnosticPath,
  diagnosticRedactor,
  environmentSecrets,
} from "./diagnostic-redaction";

type RecordData = Record<string, unknown>;
const object = (value: unknown): RecordData =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordData)
    : {};

// Rebuild, never extract an untrusted archive into a directory. Resource bodies,
// source files, raw screenshots, arbitrary attachments and stack source are NOT
// exportable. Preserve only Playwright action/DOM/network diagnostic records.
export async function traceEntries(file: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      file,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) return reject(new Error("TRACE_ARCHIVE_INVALID"));
        const entries = new Map<string, Buffer>();
        let total = 0;
        let count = 0;
        const fail = () => {
          zip.close();
          reject(new Error("TRACE_ARCHIVE_INVALID"));
        };
        zip.on("error", fail);
        zip.on("end", () => resolve(entries));
        zip.on("entry", (entry) => {
          if (++count > 20_000 || entry.uncompressedSize > 100_000_000)
            return fail();
          if (!/^[\w-]+\.(trace|network)$/.test(entry.fileName))
            return zip.readEntry();
          total += entry.uncompressedSize;
          if (total > 250_000_000 || entries.has(entry.fileName)) return fail();
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return fail();
            const chunks: Buffer[] = [];
            stream.on("error", fail);
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () => {
              entries.set(entry.fileName, Buffer.concat(chunks));
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}

// Stored ZIP entries: no new dependency, bounded diagnostic files only.
export function diagnosticZip(entries: Map<string, Buffer>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const filename = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(body), 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, body);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    header.copy(directory, 8, 6, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export function safeTraceRecord(
  input: unknown,
  redact: (text: string) => string,
): RecordData | null {
  const row = object(input);
  const pick = (source: RecordData, keys: string[]) =>
    Object.fromEntries(
      keys.flatMap<[string, string | number | boolean]>((key) => {
        const value = source[key];
        return typeof value === "number" || typeof value === "boolean"
          ? [[key, value]]
          : typeof value === "string"
            ? [[key, redact(value)]]
            : [];
      }),
    );
  const url = (value: unknown) =>
    `http://diagnostic.invalid${diagnosticPath(String(value), redact)}`;
  const html = (node: unknown): unknown => {
    if (typeof node === "string") return redact(node);
    if (!Array.isArray(node)) return typeof node === "number" ? node : null;
    if (typeof node[0] !== "string") return node.map(html);
    const [tag, attributes, ...children] = node;
    const hidden = /^(SCRIPT|STYLE|INPUT|TEXTAREA|PRE|CODE)$/i.test(tag);
    const attrs = pick(object(attributes), [
      "role",
      "aria-label",
      "aria-hidden",
      "type",
      "placeholder",
      "disabled",
      "hidden",
      "readonly",
    ]);
    return [
      /^(SCRIPT|STYLE)$/i.test(tag) ? "DIV" : tag,
      attrs,
      ...children.map((child) => (hidden ? "[REDACTED]" : html(child))),
    ];
  };
  switch (row.type) {
    case "context-options":
      return {
        ...pick(row, [
          "type",
          "version",
          "origin",
          "browserName",
          "playwrightVersion",
          "platform",
          "wallTime",
          "monotonicTime",
          "sdkLanguage",
          "testTimeout",
        ]),
        options: {
          viewport: pick(object(object(row.options).viewport), [
            "width",
            "height",
          ]),
        },
      };
    case "before":
      return {
        ...pick(row, [
          "type",
          "callId",
          "parentId",
          "stepId",
          "startTime",
          "class",
          "method",
          "pageId",
          "beforeSnapshot",
        ]),
        title: redact(String(row.method ?? "action")),
        params: pick(object(row.params), ["selector"]),
        stack: Array.isArray(row.stack)
          ? row.stack.map((frame) => ({
              ...pick(object(frame), ["line", "column"]),
              file: redact(
                path.basename(String(object(frame).file ?? "unknown")),
              ),
            }))
          : [],
      };
    case "after":
      return {
        ...pick(row, ["type", "callId", "endTime", "afterSnapshot", "point"]),
        ...(row.error
          ? {
              error: {
                name: "Error",
                message: "Action failed; inspect timing and sanitized DOM",
              },
            }
          : {}),
      };
    case "input":
      return pick(row, ["type", "callId", "inputSnapshot"]);
    case "frame-snapshot": {
      const snapshot = object(row.snapshot);
      return {
        type: row.type,
        snapshot: {
          ...pick(snapshot, [
            "callId",
            "phase",
            "snapshotName",
            "pageId",
            "frameId",
            "timestamp",
            "wallTime",
            "collectionTime",
            "isMainFrame",
          ]),
          frameUrl: url(snapshot.frameUrl),
          html: html(snapshot.html),
          viewport: pick(object(snapshot.viewport), ["width", "height"]),
          resourceOverrides: [],
        },
      };
    }
    case "resource-snapshot": {
      const snapshot = object(row.snapshot);
      const request = object(snapshot.request);
      return {
        type: row.type,
        snapshot: {
          ...pick(snapshot, [
            "_frameref",
            "_monotonicTime",
            "startedDateTime",
            "time",
          ]),
          request: {
            method: request.method,
            url: url(request.url),
            httpVersion: "HTTP/1.1",
            headers: [],
            cookies: [],
            queryString: [],
            headersSize: -1,
            bodySize: -1,
          },
          response: {
            ...pick(object(snapshot.response), ["status"]),
            statusText: "",
            httpVersion: "HTTP/1.1",
            headers: [],
            cookies: [],
            content: { size: 0, mimeType: "text/plain" },
            redirectURL: "",
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: pick(object(snapshot.timings), ["send", "wait", "receive"]),
        },
      };
    }
    // Arbitrary console/log/error strings may contain tokens not known to the
    // environment. Retain severity and time, not their payload or arguments.
    case "console":
      return {
        ...pick(row, ["type", "time", "pageId", "messageType"]),
        text: "[CONSOLE_PAYLOAD_OMITTED]",
        args: [],
      };
    case "event":
      return { ...pick(row, ["type", "time", "class", "method"]), params: {} };
    default:
      return null;
  }
}

export async function collectSafeArtifacts(
  source: string,
  destination: string,
) {
  const values = environmentSecrets();
  for (const name of [".env", ".env.test", ".env.ci-db"]) {
    // The CI env is mandatory: fail closed rather than exporting without the
    // known fixture credentials. This runs before the always cleanup step.
    values.push(
      ...environmentSecrets(
        parseEnv(await readFile(path.join(source, name), "utf8")),
      ),
    );
  }
  const redact = diagnosticRedactor(values);
  const output: Array<[string, Buffer]> = [];
  let count = 0;
  async function walk(directory: string, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("ARTIFACT_SYMLINK_REJECTED");
      if (entry.isDirectory()) {
        await walk(file, name);
        continue;
      }
      if (++count > 10_000 || (await lstat(file)).size > 250_000_000)
        throw new Error("ARTIFACT_LIMIT");
      if (entry.name === "trace.zip") {
        const safe = new Map<string, Buffer>();
        for (const [key, buffer] of await traceEntries(file)) {
          const rows = buffer
            .toString("utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => safeTraceRecord(JSON.parse(line), redact))
            .filter(Boolean);
          safe.set(
            key,
            Buffer.from(
              rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
            ),
          );
        }
        if (!safe.size) throw new Error("TRACE_EMPTY");
        output.push([name, diagnosticZip(safe)]);
      } else if (
        [
          "safe-network.json",
          "safe-timing.jsonl",
          "safe-server.jsonl",
        ].includes(entry.name)
      ) {
        output.push([name, Buffer.from(redact(await readFile(file, "utf8")))]);
      } else if (entry.name === "safe-failure.png") {
        const png = await readFile(file);
        if (
          !png
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          throw new Error("SCREENSHOT_INVALID");
        output.push([name, png]);
      }
    }
  }
  await walk(path.join(source, "test-results"));
  if (!output.some(([name]) => name.endsWith("trace.zip")))
    throw new Error("FAILURE_TRACE_MISSING");
  // No partial package on sanitizer failure. The workflow also checks step
  // success before upload, so even a write failure cannot upload partial data.
  await mkdir(destination, { mode: 0o700 });
  for (const [name, buffer] of output) {
    const file = path.join(destination, name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, buffer, { mode: 0o600, flag: "wx" });
  }
  return output.length;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  collectSafeArtifacts(
    path.resolve(process.argv[2]!),
    path.resolve(process.argv[3]!),
  ).then(
    (count) => console.log(`Safe failure diagnostics: ${count} files`),
    () => {
      console.error("FAIL: diagnostics not safe to upload; details suppressed");
      process.exitCode = 1;
    },
  );
}
