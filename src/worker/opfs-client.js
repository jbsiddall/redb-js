/**
 * Main-thread async client for the OPFS Redb + RedbFS Dedicated Web Worker.
 * Zero dependencies.
 */

export class OpfsRedbClient {
  /**
   * @param {Worker} worker
   */
  constructor(worker) {
    this._worker = worker;
    this._nextId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function }>} */
    this._pending = new Map();

    worker.onmessage = (event) => {
      const { id, ok, result, error } = event.data;
      const p = this._pending.get(id);
      if (!p) return;
      this._pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error));
    };

    worker.onerror = (err) => {
      const e = new Error(err.message || "OPFS worker error");
      for (const p of this._pending.values()) p.reject(e);
      this._pending.clear();
    };
  }

  /**
   * Spawn the OPFS worker and open a single-file redb database in OPFS.
   *
   * @param {string} path Relative OPFS path (e.g. "app.redb")
   * @param {{ cacheSize?: number, chunkSize?: number, readOnly?: boolean, wasm?: string | URL, workerUrl?: string | URL }} [options]
   */
  static async open(path, options = {}) {
    const workerUrl =
      options.workerUrl ?? new URL("./opfs-worker.js", import.meta.url);
    const worker = new Worker(workerUrl, { type: "module" });
    const client = new OpfsRedbClient(worker);
    const { workerUrl: _ignored, ...openOpts } = options;
    if (openOpts.wasm instanceof URL) {
      openOpts.wasm = openOpts.wasm.href;
    }
    await client._call("open", [path, openOpts]);
    return client;
  }

  _call(method, args = [], transfer = []) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ id, method, args }, transfer);
    });
  }

  // --- KV API ---
  get(table, key) {
    return this._call("kv.get", [table, key]);
  }
  getText(table, key) {
    return this._call("kv.getText", [table, key]);
  }
  set(table, key, value, options) {
    return this._call("kv.set", [table, key, value, options]);
  }
  delete(table, key, options) {
    return this._call("kv.delete", [table, key, options]);
  }
  scan(table, options) {
    return this._call("kv.scan", [table, options]);
  }
  listTables() {
    return this._call("kv.listTables");
  }
  batch(ops, options) {
    return this._call("kv.batch", [ops, options]);
  }

  // --- Virtual Filesystem API ---
  writeFile(path, data, options) {
    return this._call("fs.writeFile", [path, data, options]);
  }
  appendFile(path, data, options) {
    return this._call("fs.appendFile", [path, data, options]);
  }
  readFile(path) {
    return this._call("fs.readFile", [path]);
  }
  readTextFile(path) {
    return this._call("fs.readTextFile", [path]);
  }
  readRange(path, offset, length) {
    return this._call("fs.readRange", [path, offset, length]);
  }
  writeRange(path, offset, data, options) {
    return this._call("fs.writeRange", [path, offset, data, options]);
  }
  truncate(path, newSize) {
    return this._call("fs.truncate", [path, newSize]);
  }
  stat(path) {
    return this._call("fs.stat", [path]);
  }
  exists(path) {
    return this._call("fs.exists", [path]);
  }
  mkdir(path, options) {
    return this._call("fs.mkdir", [path, options]);
  }
  readdir(path = "/") {
    return this._call("fs.readdir", [path]);
  }
  unlink(path) {
    return this._call("fs.unlink", [path]);
  }
  rm(path, options) {
    return this._call("fs.rm", [path, options]);
  }
  rename(oldPath, newPath) {
    return this._call("fs.rename", [oldPath, newPath]);
  }

  // --- Snapshots & maintenance ---
  snapshot() {
    return this._call("snapshot");
  }
  restoreSnapshot(snapshotId) {
    return this._call("restoreSnapshot", [snapshotId]);
  }
  deleteSnapshot(snapshotId) {
    return this._call("deleteSnapshot", [snapshotId]);
  }
  listSnapshots() {
    return this._call("listSnapshots");
  }
  compact() {
    return this._call("compact");
  }
  checkIntegrity() {
    return this._call("checkIntegrity");
  }
  fileSize() {
    return this._call("fileSize");
  }

  async close() {
    try {
      await this._call("close");
    } finally {
      this._worker.terminate();
    }
  }
}
