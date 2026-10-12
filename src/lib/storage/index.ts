import { parseServerEnv } from "@/lib/env";
import { LocalStorageProvider } from "@/lib/storage/local";

let storage: LocalStorageProvider | undefined;

export function getStorageProvider() {
  if (storage) return storage;
  const env = parseServerEnv();
  if (env.STORAGE_DRIVER !== "local") {
    throw new Error("Only the local storage provider is implemented in V1");
  }
  if (!env.LOCAL_STORAGE_ROOT) {
    throw new Error("LOCAL_STORAGE_ROOT is required for local storage");
  }
  storage = new LocalStorageProvider(env.LOCAL_STORAGE_ROOT);
  return storage;
}

export type { StorageProvider } from "@/lib/storage/provider";
