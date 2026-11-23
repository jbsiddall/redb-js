import { createMemoryBackend } from "./backends/memory.js";
import { createOpfsBackend, createOpfsBackendFromHandle } from "./backends/opfs.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Normalize a string or Uint8Array to a Uint8Array.
 * @param {string | Uint8Array} input
 * @returns {Uint8Array}
 */
export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === "string") return encoder.encode(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("Expected string or Uint8Array");
}

/**
 * Compute the exclusive upper bound for a lexicographic prefix scan.
 * Returns null if all bytes are 0xff (meaning unbounded upper limit).
 * @param {Uint8Array} prefix
 * @returns {Uint8Array | null}
 */
export function prefixUpperBound(prefix) {
  for (let i = prefix.length - 1; i >= 0; i--) {
    if (prefix[i] < 0xff) {
      const upper = prefix.slice(0, i + 1);
      upper[i] += 1;
      return upper;
    }
  }
  return null;
}

/**
 * Load raw WASM bytes in browser/worker or Node.js without any bundler assumptions.
 * @param {Uint8Array | ArrayBuffer | WebAssembly.Module | URL | string} [wasmSource]
 * @returns {Promise<WebAssembly.Module>}
 */
async function loadWasmModule(wasmSource) {
  if (wasmSource instanceof WebAssembly.Module) {
    return wasmSource;
  }
  if (wasmSource instanceof Uint8Array || wasmSource instanceof ArrayBuffer) {
    return WebAssembly.compile(wasmSource);
  }

  const url =
    wasmSource instanceof URL
      ? wasmSource
      : typeof wasmSource === "string"
        ? new URL(wasmSource, import.meta.url)
        : new URL("../dist/redb_wasm.wasm", import.meta.url);

  if (url.protocol === "file:" && typeof process !== "undefined" && process.versions?.node) {
    const fsPromises = await import("node:fs/promises");
    const bytes = await fsPromises.readFile(url);
    return WebAssembly.compile(bytes);
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch redb WASM from ${url}: HTTP ${res.status}`);
  }
  if (typeof WebAssembly.compileStreaming === "function") {
    try {
      return await WebAssembly.compileStreaming(res.clone());
    } catch {
      // Fallback if server doesn't serve application/wasm MIME type
    }
  }
  const bytes = await res.arrayBuffer();
  return WebAssembly.compile(bytes);
}

/**
 * Instantiate an isolated redb WASM runtime wired to JS host StorageBackend callbacks.
 */
class WasmRuntime {
  /**
   * @param {WebAssembly.Module} mod
   */
  constructor(mod) {
    this.nextBackendHandle = 1;
    /** @type {Map<number, { backend: any, lastError: Error | null }>} */
    this.backends = new Map();
    /** @type {WebAssembly.Exports | null} */
    this.exports = null;

    const getMemU8 = () => new Uint8Array(this.exports.memory.buffer);

    const imports = {
      env: {
        host_read: (handle, offset, dstPtr, dstLen) => {
          const entry = this.backends.get(handle);
          if (!entry) return -1;
          try {
            const view = getMemU8().subarray(dstPtr, dstPtr + dstLen);
            return entry.backend.read(offset, view);
          } catch (err) {
            entry.lastError = err instanceof Error ? err : new Error(String(err));
            return -1;
          }
        },
        host_write: (handle, offset, srcPtr, srcLen) => {
          const entry = this.backends.get(handle);
          if (!entry) return -1;
          try {
            const view = getMemU8().subarray(srcPtr, srcPtr + srcLen);
            entry.backend.write(offset, view);
            return 0;
          } catch (err) {
            entry.lastError = err instanceof Error ? err : new Error(String(err));
            return -1;
          }
        },
        host_len: (handle) => {
          const entry = this.backends.get(handle);
          if (!entry) return -1;
          try {
            return entry.backend.len();
          } catch (err) {
            entry.lastError = err instanceof Error ? err : new Error(String(err));
            return -1;
          }
        },
        host_set_len: (handle, newLen) => {
          const entry = this.backends.get(handle);
          if (!entry) return -1;
          try {
            entry.backend.setLen(newLen);
            return 0;
          } catch (err) {
            entry.lastError = err instanceof Error ? err : new Error(String(err));
            return -1;
          }
        },
        host_sync: (handle) => {
          const entry = this.backends.get(handle);
          if (!entry) return -1;
          try {
            entry.backend.sync();
            return 0;
          } catch (err) {
            entry.lastError = err instanceof Error ? err : new Error(String(err));
            return -1;
          }
        },
        host_close: (handle) => {
          const entry = this.backends.get(handle);
          if (!entry) return 0;
          try {
            entry.backend.close();
            this.backends.delete(handle);
            return 0;
          } catch (err) {
            entry.lastError = err instanceof Error ? err : new Error(String(err));
            return -1;
          }
        },
      },
    };

    const instance = new WebAssembly.Instance(mod, imports);
    this.exports = instance.exports;
  }

  registerBackend(backend) {
    const handle = this.nextBackendHandle++;
    this.backends.set(handle, { backend, lastError: null });
    return handle;
  }

  getLastError(backendHandle) {
    const ptr = this.exports.last_error_ptr();
    const len = this.exports.last_error_len();
    const wasmMsg =
      len > 0
        ? decoder.decode(new Uint8Array(this.exports.memory.buffer, ptr, len))
        : "unknown redb error";
    const entry = backendHandle != null ? this.backends.get(backendHandle) : null;
    if (entry?.lastError) {
      const cause = entry.lastError;
      entry.lastError = null;
      return new Error(`${wasmMsg} (backend: ${cause.message})`, { cause });
    }
    return new Error(wasmMsg);
  }

  readResultCopy() {
    const ptr = this.exports.result_ptr();
    const len = this.exports.result_len();
    if (len === 0) return new Uint8Array(0);
    return new Uint8Array(this.exports.memory.buffer, ptr, len).slice();
  }

  /**
   * Copy JS bytes into WASM memory, run callback, and free.
   * @template T
   * @param {Uint8Array[]} buffers
   * @param {(ptrs: number[], lens: number[]) => T} fn
   * @returns {T}
   */
  withBuffers(buffers, fn) {
    const ptrs = [];
    const lens = [];
    try {
      for (const b of buffers) {
        if (!b || b.byteLength === 0) {
          ptrs.push(0);
          lens.push(0);
        } else {
          const ptr = this.exports.alloc(b.byteLength);
          new Uint8Array(this.exports.memory.buffer, ptr, b.byteLength).set(b);
          ptrs.push(ptr);
          lens.push(b.byteLength);
        }
      }
      return fn(ptrs, lens);
    } finally {
      for (let i = 0; i < ptrs.length; i++) {
        if (ptrs[i] !== 0 && lens[i] > 0) {
          this.exports.dealloc(ptrs[i], lens[i]);
        }
      }
    }
  }

  decodeScanResult() {
    const buf = this.readResultCopy();
    if (buf.byteLength < 4) return [];
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const count = view.getUint32(0, true);
    const out = new Array(count);
    let pos = 4;
    for (let i = 0; i < count; i++) {
      const kLen = view.getUint32(pos, true);
      pos += 4;
      const key = buf.slice(pos, pos + kLen);
      pos += kLen;
      const vLen = view.getUint32(pos, true);
      pos += 4;
      const value = buf.slice(pos, pos + vLen);
      pos += vLen;
      out[i] = { key, value };
    }
    return out;
  }
}

/** @type {Promise<WebAssembly.Module> | null} */
let defaultModulePromise = null;
/** @type {WasmRuntime | null} */
let defaultRuntime = null;

async function getRuntime(wasmSource) {
  if (wasmSource) {
    const mod = await loadWasmModule(wasmSource);
    return new WasmRuntime(mod);
  }
  if (!defaultRuntime) {
    if (!defaultModulePromise) {
      defaultModulePromise = loadWasmModule();
    }
    const mod = await defaultModulePromise;
    if (!defaultRuntime) {
      defaultRuntime = new WasmRuntime(mod);
    }
  }
  return defaultRuntime;
}

function resolveScanBounds(options = {}) {
  let startBytes = null;
  let endBytes = null;
  if (options.prefix !== undefined) {
    startBytes = toBytes(options.prefix);
    endBytes = prefixUpperBound(startBytes);
  } else {
    if (options.start !== undefined) startBytes = toBytes(options.start);
    if (options.end !== undefined) endBytes = toBytes(options.end);
  }
  return {
    startBytes,
    endBytes,
    reverse: options.reverse ? 1 : 0,
    limit: options.limit ? options.limit >>> 0 : 0,
  };
}

/**
 * MVCC snapshot read transaction.
 */
export class ReadTransaction {
  constructor(runtime, txId, backendHandle) {
    this._rt = runtime;
    this._id = txId;
    this._backendHandle = backendHandle;
    this._closed = false;
  }

  _ensureOpen() {
    if (this._closed) throw new Error("ReadTransaction is already closed");
  }

  /**
   * @param {string} table
   * @param {string | Uint8Array} key
   * @returns {Uint8Array | null}
   */
  get(table, key) {
    this._ensureOpen();
    const tBytes = toBytes(table);
    const kBytes = toBytes(key);
    const rc = this._rt.withBuffers([tBytes, kBytes], (p, l) =>
      this._rt.exports.rtx_get(this._id, p[0], l[0], p[1], l[1])
    );
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
    return rc === 1 ? this._rt.readResultCopy() : null;
  }

  /**
   * @param {string} table
   * @param {string | Uint8Array} key
   * @returns {string | null}
   */
  getText(table, key) {
    const bytes = this.get(table, key);
    return bytes === null ? null : decoder.decode(bytes);
  }

  /**
   * @param {string} table
   * @param {{ start?: string | Uint8Array, end?: string | Uint8Array, prefix?: string | Uint8Array, reverse?: boolean, limit?: number }} [options]
   * @returns {Array<{ key: Uint8Array, value: Uint8Array }>}
   */
  scan(table, options = {}) {
    this._ensureOpen();
    const tBytes = toBytes(table);
    const { startBytes, endBytes, reverse, limit } = resolveScanBounds(options);
    const rc = this._rt.withBuffers(
      [tBytes, startBytes ?? new Uint8Array(0), endBytes ?? new Uint8Array(0)],
      (p, l) =>
        this._rt.exports.rtx_scan(
          this._id,
          p[0],
          l[0],
          p[1],
          l[1],
          startBytes !== null ? 1 : 0,
          p[2],
          l[2],
          endBytes !== null ? 1 : 0,
          reverse,
          limit
        )
    );
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
    return this._rt.decodeScanResult();
  }

  /** @returns {string[]} */
  listTables() {
    this._ensureOpen();
    const rc = this._rt.exports.rtx_list_tables(this._id);
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
    const buf = this._rt.readResultCopy();
    if (buf.byteLength < 4) return [];
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const count = view.getUint32(0, true);
    const names = new Array(count);
    let pos = 4;
    for (let i = 0; i < count; i++) {
      const len = view.getUint32(pos, true);
      pos += 4;
      names[i] = decoder.decode(buf.subarray(pos, pos + len));
      pos += len;
    }
    return names;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    const rc = this._rt.exports.rtx_close(this._id);
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
  }
}

/**
 * Full ACID write transaction.
 */
export class WriteTransaction {
  constructor(runtime, txId, backendHandle) {
    this._rt = runtime;
    this._id = txId;
    this._backendHandle = backendHandle;
    this._finished = false;
  }

  _ensureOpen() {
    if (this._finished) throw new Error("WriteTransaction is already finished");
  }

  /**
   * @param {string} table
   * @param {string | Uint8Array} key
   * @returns {Uint8Array | null}
   */
  get(table, key) {
    this._ensureOpen();
    const tBytes = toBytes(table);
    const kBytes = toBytes(key);
    const rc = this._rt.withBuffers([tBytes, kBytes], (p, l) =>
      this._rt.exports.wtx_get(this._id, p[0], l[0], p[1], l[1])
    );
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
    return rc === 1 ? this._rt.readResultCopy() : null;
  }

  /**
   * @param {string} table
   * @param {string | Uint8Array} key
   * @returns {string | null}
   */
  getText(table, key) {
    const bytes = this.get(table, key);
    return bytes === null ? null : decoder.decode(bytes);
  }

  /**
   * @param {string} table
   * @param {string | Uint8Array} key
   * @param {string | Uint8Array} value
   */
  set(table, key, value) {
    this._ensureOpen();
    const tBytes = toBytes(table);
    const kBytes = toBytes(key);
    const vBytes = toBytes(value);
    const rc = this._rt.withBuffers([tBytes, kBytes, vBytes], (p, l) =>
      this._rt.exports.wtx_set(this._id, p[0], l[0], p[1], l[1], p[2], l[2])
    );
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
  }

  /**
   * @param {string} table
   * @param {string | Uint8Array} key
   * @returns {boolean}
   */
  delete(table, key) {
    this._ensureOpen();
    const tBytes = toBytes(table);
    const kBytes = toBytes(key);
    const rc = this._rt.withBuffers([tBytes, kBytes], (p, l) =>
      this._rt.exports.wtx_delete(this._id, p[0], l[0], p[1], l[1])
    );
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
    return rc === 1;
  }

  /**
   * @param {string} table
   * @returns {boolean}
   */
  deleteTable(table) {
    this._ensureOpen();
    const tBytes = toBytes(table);
    const rc = this._rt.withBuffers([tBytes], (p, l) =>
      this._rt.exports.wtx_delete_table(this._id, p[0], l[0])
    );
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
    return rc === 1;
  }

  /**
   * @param {string} table
   * @param {{ start?: string | Uint8Array, end?: string | Uint8Array, prefix?: string | Uint8Array, reverse?: boolean, limit?: number }} [options]
   * @returns {Array<{ key: Uint8Array, value: Uint8Array }>}
   */
  scan(table, options = {}) {
    this._ensureOpen();
    const tBytes = toBytes(table);
    const { startBytes, endBytes, reverse, limit } = resolveScanBounds(options);
    const rc = this._rt.withBuffers(
      [tBytes, startBytes ?? new Uint8Array(0), endBytes ?? new Uint8Array(0)],
      (p, l) =>
        this._rt.exports.wtx_scan(
          this._id,
          p[0],
          l[0],
          p[1],
          l[1],
          startBytes !== null ? 1 : 0,
          p[2],
          l[2],
          endBytes !== null ? 1 : 0,
          reverse,
          limit
        )
    );
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
    return this._rt.decodeScanResult();
  }

  /**
   * Create a persistent Copy-on-Write savepoint capturing the database state.
   * @returns {number} Savepoint ID
   */
  createSavepoint() {
    this._ensureOpen();
    const id = this._rt.exports.wtx_savepoint_create(this._id);
    if (id < 0) throw this._rt.getLastError(this._backendHandle);
    return id;
  }

  /**
   * Restore the entire database to a previously created persistent savepoint.
   * @param {number} savepointId
   */
  restoreSavepoint(savepointId) {
    this._ensureOpen();
    const rc = this._rt.exports.wtx_savepoint_restore(this._id, savepointId);
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
  }

  /**
   * Delete a persistent savepoint so its pages can be reclaimed.
   * @param {number} savepointId
   * @returns {boolean}
   */
  deleteSavepoint(savepointId) {
    this._ensureOpen();
    const rc = this._rt.exports.wtx_savepoint_delete(this._id, savepointId);
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
    return rc === 1;
  }

  /** @returns {number[]} */
  listSavepoints() {
    this._ensureOpen();
    const rc = this._rt.exports.wtx_savepoint_list(this._id);
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
    const buf = this._rt.readResultCopy();
    if (buf.byteLength < 4) return [];
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const count = view.getUint32(0, true);
    const ids = new Array(count);
    for (let i = 0; i < count; i++) {
      ids[i] = view.getFloat64(4 + i * 8, true);
    }
    return ids;
  }

  commit() {
    this._ensureOpen();
    this._finished = true;
    const rc = this._rt.exports.wtx_commit(this._id);
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
  }

  abort() {
    if (this._finished) return;
    this._finished = true;
    const rc = this._rt.exports.wtx_abort(this._id);
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
  }
}

/**
 * Thin JavaScript wrapper over redb (Copy-on-Write B-tree, ACID transactions,
 * RAM page cache, persistent savepoints) backed by a single file.
 */
export class Redb {
  constructor(runtime, dbId, backendHandle, backend) {
    this._rt = runtime;
    this._id = dbId;
    this._backendHandle = backendHandle;
    this.backend = backend;
    this._closed = false;
  }

  /**
   * Open (or create) a redb database using any synchronous StorageBackend.
   * @param {object} backend
   * @param {{ cacheSize?: number, readOnly?: boolean, wasm?: Uint8Array | ArrayBuffer | WebAssembly.Module | URL | string }} [options]
   * @returns {Promise<Redb>}
   */
  static async open(backend, options = {}) {
    const rt = await getRuntime(options.wasm);
    const backendHandle = rt.registerBackend(backend);
    const cacheBytes = options.cacheSize ?? 16 * 1024 * 1024; // 16 MiB default RAM cache
    const readOnly = options.readOnly ? 1 : 0;

    const dbId = rt.exports.db_open(backendHandle, cacheBytes >>> 0, readOnly);
    if (dbId < 0) {
      const err = rt.getLastError(backendHandle);
      rt.backends.delete(backendHandle);
      throw err;
    }
    return new Redb(rt, dbId, backendHandle, backend);
  }

  /**
   * Open a single-file redb database in the browser's Origin Private File System (OPFS).
   * Must be called inside a Dedicated Web Worker.
   *
   * @param {string} path Relative OPFS path (e.g. "app.redb")
   * @param {{ cacheSize?: number, readOnly?: boolean, create?: boolean, wasm?: Uint8Array | ArrayBuffer | WebAssembly.Module | URL | string }} [options]
   * @returns {Promise<Redb>}
   */
  static async openOpfs(path, options = {}) {
    const backend = await createOpfsBackend(path, {
      create: options.readOnly ? false : options.create !== false,
    });
    try {
      return await Redb.open(backend, options);
    } catch (err) {
      try {
        backend.close();
      } catch {}
      throw err;
    }
  }

  /**
   * Open a single-file redb database in memory (great for tests or importing/exporting bytes).
   * @param {Uint8Array} [initialBytes]
   * @param {{ cacheSize?: number, readOnly?: boolean, wasm?: Uint8Array | ArrayBuffer | WebAssembly.Module | URL | string }} [options]
   * @returns {Promise<Redb>}
   */
  static async openMemory(initialBytes, options = {}) {
    const backend = createMemoryBackend(initialBytes);
    return Redb.open(backend, options);
  }

  _ensureOpen() {
    if (this._closed) throw new Error("Redb database is closed");
  }

  beginRead() {
    this._ensureOpen();
    const txId = this._rt.exports.rtx_begin(this._id);
    if (txId < 0) throw this._rt.getLastError(this._backendHandle);
    return new ReadTransaction(this._rt, txId, this._backendHandle);
  }

  /**
   * @param {{ durable?: boolean }} [options]
   */
  beginWrite(options = {}) {
    this._ensureOpen();
    const durable = options.durable === false ? 0 : 1;
    const txId = this._rt.exports.wtx_begin(this._id, durable);
    if (txId < 0) throw this._rt.getLastError(this._backendHandle);
    return new WriteTransaction(this._rt, txId, this._backendHandle);
  }

  /**
   * Run a read-only MVCC snapshot transaction. Automatically closed on exit.
   * @template T
   * @param {(tx: ReadTransaction) => T} fn
   * @returns {T}
   */
  readTransaction(fn) {
    const tx = this.beginRead();
    try {
      return fn(tx);
    } finally {
      tx.close();
    }
  }

  /**
   * Run a full ACID write transaction. Commits automatically, or aborts if `fn` throws.
   * @template T
   * @param {(tx: WriteTransaction) => T} fn
   * @param {{ durable?: boolean }} [options]
   * @returns {T}
   */
  writeTransaction(fn, options = {}) {
    const tx = this.beginWrite(options);
    try {
      const result = fn(tx);
      tx.commit();
      return result;
    } catch (err) {
      try {
        tx.abort();
      } catch {}
      throw err;
    }
  }

  get(table, key) {
    return this.readTransaction((tx) => tx.get(table, key));
  }

  getText(table, key) {
    return this.readTransaction((tx) => tx.getText(table, key));
  }

  set(table, key, value, options) {
    return this.writeTransaction((tx) => tx.set(table, key, value), options);
  }

  delete(table, key, options) {
    return this.writeTransaction((tx) => tx.delete(table, key), options);
  }

  deleteTable(table, options) {
    return this.writeTransaction((tx) => tx.deleteTable(table), options);
  }

  scan(table, options) {
    return this.readTransaction((tx) => tx.scan(table, options));
  }

  listTables() {
    return this.readTransaction((tx) => tx.listTables());
  }

  createSavepoint() {
    return this.writeTransaction((tx) => tx.createSavepoint());
  }

  restoreSavepoint(savepointId) {
    return this.writeTransaction((tx) => tx.restoreSavepoint(savepointId));
  }

  deleteSavepoint(savepointId) {
    return this.writeTransaction((tx) => tx.deleteSavepoint(savepointId));
  }

  listSavepoints() {
    return this.writeTransaction((tx) => tx.listSavepoints(), { durable: false });
  }

  compact() {
    this._ensureOpen();
    const rc = this._rt.exports.db_compact(this._id);
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
    return rc === 1;
  }

  checkIntegrity() {
    this._ensureOpen();
    const rc = this._rt.exports.db_check_integrity(this._id);
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
    return rc === 1;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    const rc = this._rt.exports.db_close(this._id);
    if (rc < 0) throw this._rt.getLastError(this._backendHandle);
  }
}

export { createMemoryBackend, createOpfsBackend, createOpfsBackendFromHandle };
