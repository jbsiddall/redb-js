export type BytesInput = string | Uint8Array;
export type WasmSource = Uint8Array | ArrayBuffer | WebAssembly.Module | URL | string;

export interface StorageBackend {
  read(offset: number, dst: Uint8Array): number;
  write(offset: number, src: Uint8Array): void;
  len(): number;
  setLen(newLen: number): void;
  sync(): void;
  close(): void;
}

export interface MemoryBackend extends StorageBackend {
  toUint8Array(): Uint8Array;
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
}

export interface WriteTxOptions {
  /** If false, uses Durability::None for fast un-fsynced batches (default: true). */
  durable?: boolean;
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
  getText(table: string, key: BytesInput): string | null;
  scan(table: string, options?: ScanOptions): ScanEntry[];
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
  static openOpfs(path: string, options?: OpfsOpenOptions): Promise<Redb>;
  static openMemory(initialBytes?: Uint8Array, options?: OpenOptions): Promise<Redb>;

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

  compact(): boolean;
  checkIntegrity(): boolean;
  close(): void;
}

export function toBytes(input: BytesInput): Uint8Array;
export function prefixUpperBound(prefix: Uint8Array): Uint8Array | null;
export function createMemoryBackend(initialBytes?: Uint8Array): MemoryBackend;
export function createOpfsBackend(
  path: string,
  options?: { create?: boolean }
): Promise<StorageBackend>;
export function createOpfsBackendFromHandle(
  syncHandle: FileSystemSyncAccessHandle
): StorageBackend;
