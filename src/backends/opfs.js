/**
 * Browser OPFS (Origin Private File System) single-file backend for redb-wasm.
 *
 * Uses FileSystemSyncAccessHandle, which is available inside Dedicated Web Workers
 * in all modern browsers (Chrome, Firefox, Safari, Edge).
 */

/**
 * Wrap an already-opened FileSystemSyncAccessHandle as a redb-wasm StorageBackend.
 * @param {FileSystemSyncAccessHandle} syncHandle
 */
export function createOpfsBackendFromHandle(syncHandle) {
  let closed = false;

  const ensureOpen = () => {
    if (closed) {
      throw new Error("OPFS backend is closed");
    }
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
      const target =
        typeof SharedArrayBuffer !== "undefined" &&
        dst.buffer instanceof SharedArrayBuffer
          ? new Uint8Array(dst.byteLength)
          : dst;

      let total = 0;
      while (total < target.byteLength) {
        const n = syncHandle.read(target.subarray(total), { at: offset + total });
        if (n === 0) break;
        total += n;
      }

      if (target !== dst && total > 0) {
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
      const source =
        typeof SharedArrayBuffer !== "undefined" &&
        src.buffer instanceof SharedArrayBuffer
          ? src.slice()
          : src;

      let total = 0;
      while (total < source.byteLength) {
        const n = syncHandle.write(source.subarray(total), { at: offset + total });
        if (n === 0) {
          throw new Error("OPFS short write (0 bytes written)");
        }
        total += n;
      }
    },

    /** @returns {number} */
    len() {
      ensureOpen();
      return syncHandle.getSize();
    },

    /** @param {number} newLen */
    setLen(newLen) {
      ensureOpen();
      syncHandle.truncate(newLen);
    },

    sync() {
      ensureOpen();
      syncHandle.flush();
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
  return createOpfsBackendFromHandle(syncHandle);
}
