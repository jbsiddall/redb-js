/**
 * Browser OPFS (Origin Private File System) single-file backend for redb-wasm.
 *
 * Uses FileSystemSyncAccessHandle, which is available inside Dedicated Web Workers
 * in all modern browsers (Chrome, Firefox, Safari, Edge).
 */

const HAS_SAB = typeof SharedArrayBuffer !== "undefined";

/**
 * Wrap an already-opened FileSystemSyncAccessHandle as a redb-wasm StorageBackend.
 * @param {FileSystemSyncAccessHandle} syncHandle
 */
export function createOpfsBackendFromHandle(syncHandle, options = {}) {
  let closed = false;
  const enableSync = options.sync !== false;
  let cachedLen = syncHandle.getSize();
  const ioOpts = { at: 0 };
  /** @type {Uint8Array | null} */
  let sabScratch = null;

  const ensureOpen = () => {
    if (closed) {
      throw new Error("OPFS backend is closed");
    }
  };

  const getSabScratch = (needed) => {
    if (!sabScratch || sabScratch.byteLength < needed) {
      let cap = 16384;
      while (cap < needed) cap *= 2;
      sabScratch = new Uint8Array(cap);
    }
    return sabScratch.subarray(0, needed);
  };

  return {
    /**
     * Read bytes from the OPFS file at `offset` into `dst`.
     * @param {number} offset
     * @param {Uint8Array} dst
     * @returns {number}
     */
    read(offset, dst) {
      ensureOpen();
      const len = dst.byteLength;
      const isSab = HAS_SAB && dst.buffer instanceof SharedArrayBuffer;
      const target = isSab ? getSabScratch(len) : dst;

      let total = 0;
      while (total < len) {
        ioOpts.at = offset + total;
        const slice = total === 0 ? target : target.subarray(total);
        const n = syncHandle.read(slice, ioOpts);
        if (n === 0) break;
        total += n;
      }

      if (isSab && total > 0) {
        dst.set(target.subarray(0, total), 0);
      }
      return total;
    },

    /**
     * Write bytes from `src` into the OPFS file at `offset`.
     * @param {number} offset
     * @param {Uint8Array} src
     */
    write(offset, src) {
      ensureOpen();
      const len = src.byteLength;
      const isSab = HAS_SAB && src.buffer instanceof SharedArrayBuffer;
      let source = src;
      if (isSab) {
        source = getSabScratch(len);
        source.set(src);
      }

      let total = 0;
      while (total < len) {
        ioOpts.at = offset + total;
        const slice = total === 0 ? source : source.subarray(total);
        const n = syncHandle.write(slice, ioOpts);
        if (n === 0) {
          throw new Error("OPFS short write (0 bytes written)");
        }
        total += n;
      }
      const end = offset + total;
      if (end > cachedLen) cachedLen = end;
    },

    /** @returns {number} */
    len() {
      ensureOpen();
      return cachedLen;
    },

    /** @param {number} newLen */
    setLen(newLen) {
      ensureOpen();
      syncHandle.truncate(newLen);
      cachedLen = newLen;
    },

    sync() {
      ensureOpen();
      if (enableSync) {
        syncHandle.flush();
      }
    },

    close() {
      if (!closed) {
        closed = true;
        syncHandle.close();
      }
    },
  };
}

/**
 * Open (or create) a single file in the browser's Origin Private File System (OPFS)
 * and return a synchronous StorageBackend backed by FileSystemSyncAccessHandle.
 *
 * Must be called inside a Dedicated Web Worker.
 *
 * @param {string} path Relative path inside OPFS (e.g. "app.redb" or "data/app.redb")
 * @param {{ create?: boolean }} [options]
 */
export async function createOpfsBackend(path, options = {}) {
  const create = options.create !== false;
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    throw new Error("OPFS is not available in this environment");
  }

  const parts = path.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) {
    throw new Error(`Invalid OPFS file path: ${path}`);
  }

  let dir = await navigator.storage.getDirectory();
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create });
  }

  const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create });
  if (typeof fileHandle.createSyncAccessHandle !== "function") {
    throw new Error(
      "FileSystemFileHandle.createSyncAccessHandle() is only available inside a Dedicated Web Worker"
    );
  }

  const syncHandle = await fileHandle.createSyncAccessHandle();
  return createOpfsBackendFromHandle(syncHandle, options);
}
