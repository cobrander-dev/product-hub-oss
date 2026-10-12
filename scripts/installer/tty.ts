import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { BootstrapFailure } from "./bootstrap";

export async function hiddenInput(label: string) {
  process.stdout.write(label);
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const reader = createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      reader.once("SIGINT", () =>
        reject(new BootstrapFailure("INPUT_CANCELLED")),
      );
      reader.once("close", () => reject(new BootstrapFailure("INPUT_CLOSED")));
      reader.question("", resolve);
    });
  } finally {
    reader.close();
    process.stdout.write("\n");
  }
}
