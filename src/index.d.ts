export type BytesInput = string | Uint8Array | ArrayBufferView;
export type WasmSource = Uint8Array | ArrayBuffer | WebAssembly.Module | URL | string;

export interface StorageBackend {
  read(offset: number, dst: Uint8Array): number;
  write(offset: number, src: Uint8Array): void;
  len(): number;
  setLen(newLen: number): void;
  flushWrites?(): void;
  sync(): void;
  close(): void;
}

export interface MemoryBackend extends StorageBackend {
  toUint8Array(): Uint8Array;
}

/**
 * Minimal structural type matching WebWorker's FileSystemSyncAccessHandle so
 * consumers in Node.js or DOM-only TypeScript configs do not require lib.webworker.d.ts.
 */
export interface OpfsSyncAccessHandle {
  read(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  getSize(): number;
  truncate(newSize: number): void;
  flush(): void;
  close(): void;
}

export interface OpenOptions {
  /** In-memory redb page cache size in bytes (default: 16 MiB). */
  cacheSize?: number;
  /** Open without modifying the file. */
  readOnly?: boolean;
  /** Optional explicit WASM binary, module, or URL. */
  wasm?: WasmSource;
}

export interface OpfsOpenOptions extends OpenOptions {
  create?: boolean;
  /** Whether backend.sync() calls syncHandle.flush() (default: true). */
  sync?: boolean;
}

export interface WriteTxOptions {
  /** If false, uses Durability::None (pages remain in redb RAM cache until eviction/close). Default: true. */
  durable?: boolean;
  /**
   * When durable is true and sync is false, writes all CoW pages and the checksummed
   * superblock to the OS/OPFS handle (process-crash/SIGKILL safe) while skipping the
   * hardware fsync/flush call until an explicit db.sync() or durable sync commit. Default: true.
   */
  sync?: boolean;
}

export interface ScanOptions {
  start?: BytesInput;
  end?: BytesInput;
  prefix?: BytesInput;
  reverse?: boolean;
  limit?: number;
}

export interface ScanEntry {
  key: Uint8Array;
  value: Uint8Array;
}

export class ReadTransaction {
  get(table: string, key: BytesInput): Uint8Array | null;
  getInto(table: string, key: BytesInput, target: Uint8Array, targetOffset?: number): number;
  /**
   * Zero-copy view into WASM memory for the value bytes, or null if not found.
   * Only valid synchronously until the next redb-js call on this runtime.
   */
  getView(table: string, key: BytesInput): Uint8Array | null;
  getText(table: string, key: BytesInput): string | null;
  scan(table: string, options?: ScanOptions): ScanEntry[];
  scanEach(
    table: string,
    options: ScanOptions,
    cb: (key: Uint8Array, value: Uint8Array) => void
  ): number;
  listTables(): string[];
  close(): void;
}

export class WriteTransaction {
  get(table: string, key: BytesInput): Uint8Array | null;
  getText(table: string, key: BytesInput): string | null;
  set(table: string, key: BytesInput, value: BytesInput): void;
  delete(table: string, key: BytesInput): boolean;
  deleteTable(table: string): boolean;
  scan(table: string, options?: ScanOptions): ScanEntry[];
  createSavepoint(): number;
  restoreSavepoint(savepointId: number): void;
  deleteSavepoint(savepointId: number): boolean;
  listSavepoints(): number[];
  commit(): void;
  abort(): void;
}

export class Redb {
  readonly backend: StorageBackend;

  static open(backend: StorageBackend, options?: OpenOptions): Promise<Redb>;
  static openSync(
    backend: StorageBackend,
    options?: Omit<OpenOptions, "wasm"> & { wasm?: Uint8Array | ArrayBuffer | WebAssembly.Module }
  ): Redb;
  static openOpfs(path: string, options?: OpfsOpenOptions): Promise<Redb>;
  static openMemory(initialBytes?: Uint8Array, options?: OpenOptions): Promise<Redb>;
  static openMemorySync(
    initialBytes?: Uint8Array,
    options?: Omit<OpenOptions, "wasm"> & { wasm?: Uint8Array | ArrayBuffer | WebAssembly.Module }
  ): Redb;

  beginRead(): ReadTransaction;
  beginWrite(options?: WriteTxOptions): WriteTransaction;
  readTransaction<T>(fn: (tx: ReadTransaction) => T): T;
  writeTransaction<T>(fn: (tx: WriteTransaction) => T, options?: WriteTxOptions): T;

  get(table: string, key: BytesInput): Uint8Array | null;
  getText(table: string, key: BytesInput): string | null;
  set(table: string, key: BytesInput, value: BytesInput, options?: WriteTxOptions): void;
  delete(table: string, key: BytesInput, options?: WriteTxOptions): boolean;
  deleteTable(table: string, options?: WriteTxOptions): boolean;
  scan(table: string, options?: ScanOptions): ScanEntry[];
  listTables(): string[];

  createSavepoint(): number;
  restoreSavepoint(savepointId: number): void;
  deleteSavepoint(savepointId: number): boolean;
  listSavepoints(): number[];

  /** Explicitly flush coalesced writes and call backend.sync(). */
  sync(): void;
  compact(): boolean;
  checkIntegrity(): boolean;
  close(): void;
}

export function toBytes(input: BytesInput): Uint8Array;
export function prefixUpperBound(prefix: Uint8Array): Uint8Array | null;
export function compileWasmSync(
  wasmSource: Uint8Array | ArrayBuffer | WebAssembly.Module
): WebAssembly.Module;
export function setDefaultWasmModule(mod: WebAssembly.Module): void;
export function createMemoryBackend(initialBytes?: Uint8Array): MemoryBackend;
export function createOpfsBackend(
  path: string,
  options?: { create?: boolean; sync?: boolean }
): Promise<StorageBackend>;
export function createOpfsBackendFromHandle(
  syncHandle: OpfsSyncAccessHandle,
  options?: { sync?: boolean }
): StorageBackend;
