import type { BytesInput, Redb } from "./index.js";

export interface VfsStat {
  type: "file" | "dir";
  size: number;
  chunkSize: number;
  ctime: number;
  mtime: number;
}

export interface VfsDirEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  ctime: number;
  mtime: number;
}

export interface VfsWriteOptions {
  createParents?: boolean;
  durable?: boolean;
}

export function normalizePath(rawPath: string): string;

export class RedbFS {
  readonly db: Redb;
  readonly chunkSize: number;

  constructor(db: Redb, options?: { chunkSize?: number });

  stat(path: string): VfsStat | null;
  exists(path: string): boolean;
  mkdir(path: string, options?: { recursive?: boolean }): void;
  readdir(path?: string): VfsDirEntry[];
  writeFile(path: string, data: BytesInput, options?: VfsWriteOptions): void;
  appendFile(path: string, data: BytesInput, options?: VfsWriteOptions): void;
  readFile(path: string): Uint8Array;
  readTextFile(path: string): string;
  readRange(path: string, offset: number, length: number): Uint8Array;
  writeRange(
    path: string,
    offset: number,
    data: BytesInput,
    options?: { durable?: boolean }
  ): void;
  truncate(path: string, newSize: number): void;
  unlink(path: string): void;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  rename(oldPath: string, newPath: string): void;

  snapshot(): number;
  restoreSnapshot(snapshotId: number): void;
  deleteSnapshot(snapshotId: number): boolean;
  listSnapshots(): number[];

  compact(): boolean;
  checkIntegrity(): boolean;
  close(): void;
}
