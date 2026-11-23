import type { OpenOptions, StorageBackend } from "./index.js";
export { Redb, ReadTransaction, WriteTransaction, toBytes, prefixUpperBound } from "./index.js";

export interface NodeOpenOptions extends OpenOptions {
  createDirs?: boolean;
  mode?: number;
}

export function createNodeFileBackend(
  filePath: string,
  options?: { readOnly?: boolean; createDirs?: boolean; mode?: number }
): StorageBackend;

export function openNode(filePath: string, options?: NodeOpenOptions): Promise<import("./index.js").Redb>;
