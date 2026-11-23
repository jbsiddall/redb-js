import type { OpenOptions, StorageBackend } from "./index.js";
export {
  Redb,
  ReadTransaction,
  WriteTransaction,
  toBytes,
  prefixUpperBound,
  compileWasmSync,
  setDefaultWasmModule,
} from "./index.js";

export interface NodeOpenOptions extends OpenOptions {
  createDirs?: boolean;
  mode?: number;
  /** Whether backend.sync() calls fsync/fdatasync (default: true). */
  sync?: boolean;
}

export interface NodeSyncOpenOptions extends Omit<NodeOpenOptions, "wasm"> {
  wasm?: Uint8Array | ArrayBuffer | WebAssembly.Module;
}

export function ensureNodeWasmLoadedSync(): void;

export function createNodeFileBackend(
  filePath: string,
  options?: { readOnly?: boolean; createDirs?: boolean; mode?: number; sync?: boolean }
): StorageBackend;

export function openNode(filePath: string, options?: NodeOpenOptions): Promise<import("./index.js").Redb>;
export function openNodeSync(filePath: string, options?: NodeSyncOpenOptions): import("./index.js").Redb;
