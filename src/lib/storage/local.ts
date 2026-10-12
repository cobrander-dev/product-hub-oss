import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { StorageProvider } from "@/lib/storage/provider";

const STORAGE_KEY_PATTERN =
  /^objects\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/;

export function createImageStorageKey() {
  return `objects/${randomUUID()}.webp`;
}

export class LocalStorageProvider implements StorageProvider {
  readonly name = "LOCAL" as const;
  readonly root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error("LOCAL_STORAGE_ROOT must be an absolute path");
    }
    this.root = path.resolve(root);
  }

  private resolveKey(storageKey: string) {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new Error("Invalid opaque storage key");
    }
    const resolved = path.resolve(this.root, storageKey);
    if (!resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Storage key escapes the configured root");
    }
    return resolved;
  }

  async put(storageKey: string, bytes: Buffer) {
    const destination = this.resolveKey(storageKey);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o750 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o640);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async open(storageKey: string) {
    const filename = this.resolveKey(storageKey);
    await access(filename, constants.R_OK);
    return createReadStream(filename);
  }

  async read(storageKey: string) {
    return readFile(this.resolveKey(storageKey));
  }

  async copy(sourceKey: string, destinationKey: string) {
    const source = this.resolveKey(sourceKey);
    const destination = this.resolveKey(destinationKey);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o750 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async delete(storageKey: string) {
    await rm(this.resolveKey(storageKey), { force: true });
  }

  async stat(storageKey: string) {
    try {
      const value = await stat(this.resolveKey(storageKey));
      return { sizeBytes: value.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async listKeys() {
    const objectsDirectory = path.join(this.root, "objects");
    let names: string[];
    try {
      names = await readdir(objectsDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return names
      .map((name) => `objects/${name}`)
      .filter((key) => STORAGE_KEY_PATTERN.test(key))
      .sort();
  }
}
