import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical JSON rejects non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  throw new Error("Canonical JSON contains an unsupported value");
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(normalize(value));
}

export function canonicalSha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
