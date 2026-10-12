import type { Readable } from "node:stream";

export type StoredFileStat = {
  sizeBytes: number;
};

export interface StorageProvider {
  readonly name: "LOCAL";
  put(storageKey: string, bytes: Buffer): Promise<void>;
  open(storageKey: string): Promise<Readable>;
  read(storageKey: string): Promise<Buffer>;
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  delete(storageKey: string): Promise<void>;
  stat(storageKey: string): Promise<StoredFileStat | null>;
  listKeys(): Promise<string[]>;
}
