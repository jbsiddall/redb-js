import type { BytesInput, ScanEntry, ScanOptions, WriteTxOptions } from "../index.js";
import type { VfsDirEntry, VfsStat, VfsWriteOptions } from "../vfs.js";

export type BatchOp =
  | { op: "set"; table: string; key: BytesInput; value: BytesInput }
  | { op: "delete"; table: string; key: BytesInput }
  | { op: "deleteTable"; table: string };

export interface OpfsClientOpenOptions {
  cacheSize?: number;
  chunkSize?: number;
  readOnly?: boolean;
  wasm?: string | URL;
  workerUrl?: string | URL;
}

export class OpfsRedbClient {
  static open(path: string, options?: OpfsClientOpenOptions): Promise<OpfsRedbClient>;

  get(table: string, key: BytesInput): Promise<Uint8Array | null>;
  getText(table: string, key: BytesInput): Promise<string | null>;
  set(table: string, key: BytesInput, value: BytesInput, options?: WriteTxOptions): Promise<boolean>;
  delete(table: string, key: BytesInput, options?: WriteTxOptions): Promise<boolean>;
  scan(table: string, options?: ScanOptions): Promise<ScanEntry[]>;
  listTables(): Promise<string[]>;
  batch(ops: BatchOp[], options?: WriteTxOptions): Promise<boolean>;

  writeFile(path: string, data: BytesInput, options?: VfsWriteOptions): Promise<boolean>;
  appendFile(path: string, data: BytesInput, options?: VfsWriteOptions): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  writeRange(
    path: string,
    offset: number,
    data: BytesInput,
    options?: { durable?: boolean }
  ): Promise<boolean>;
  truncate(path: string, newSize: number): Promise<boolean>;
  stat(path: string): Promise<VfsStat | null>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<boolean>;
  readdir(path?: string): Promise<VfsDirEntry[]>;
  unlink(path: string): Promise<boolean>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<boolean>;
  rename(oldPath: string, newPath: string): Promise<boolean>;

  snapshot(): Promise<number>;
  restoreSnapshot(snapshotId: number): Promise<boolean>;
  deleteSnapshot(snapshotId: number): Promise<boolean>;
  listSnapshots(): Promise<number[]>;
  compact(): Promise<boolean>;
  checkIntegrity(): Promise<boolean>;
  fileSize(): Promise<number>;
  close(): Promise<void>;
}
